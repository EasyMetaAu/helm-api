import { afterEach, describe, expect, it } from "vitest";
import type { MemoryStore, OAuthUsageStore } from "./ports.js";
import { PgMemoryStore } from "./postgres/memory-store.js";
import { createPgliteDb } from "./postgres/migrate.js";
import { PgOAuthUsageStore } from "./postgres/oauth-usage.js";
import { SqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteDb } from "./sqlite/migrate.js";
import { SqliteOAuthUsageStore } from "./sqlite/oauth-usage.js";

// Cross-driver (sqlite + pglite-postgres) contract for the NEW cleanup/archival
// store methods that need time control: memory_messages (the opt-in raw-transcript
// archive tier), memory_jobs housekeeping, and oauth_usage hour-bucket pruning.
// Telemetry + request_payloads archive helpers are covered in store-contract.test.ts
// (their insert APIs already take an explicit createdAt). Here the memory store's
// clock is injected per instance so we can stamp rows at deterministic timestamps.

interface Drv {
  name: string;
  open: () => Promise<{
    mkMemory: (nowMs: number) => MemoryStore;
    usage: OAuthUsageStore;
    close: () => Promise<void>;
  }>;
}

const drivers: Drv[] = [
  {
    name: "sqlite",
    open: async () => {
      const db = createSqliteDb(":memory:");
      let seq = 0;
      return {
        mkMemory: (nowMs) =>
          new SqliteMemoryStore(
            db,
            () => `id-${++seq}`,
            () => new Date(nowMs),
          ),
        usage: new SqliteOAuthUsageStore(db),
        close: async () => {
          db.$sqlite.close();
        },
      };
    },
  },
  {
    name: "pglite-postgres",
    open: async () => {
      const db = await createPgliteDb();
      let seq = 0;
      return {
        mkMemory: (nowMs) =>
          new PgMemoryStore(
            db,
            () => `id-${++seq}`,
            () => new Date(nowMs),
          ),
        usage: new PgOAuthUsageStore(db),
        close: () => db.$close(),
      };
    },
  },
];

describe.each(drivers)("Cleanup store contract — $name", ({ open }) => {
  let ctx: Awaited<ReturnType<Drv["open"]>>;
  afterEach(async () => {
    await ctx?.close();
  });

  it("memory_messages: count/select/prune use a STRICT older-than cutoff", async () => {
    ctx = await open();
    // Two messages stamped at distinct times via per-instance clocks over one db.
    const old = ctx.mkMemory(1000);
    await old.ensureThread({ id: "t", ownerId: "a" });
    await old.appendMessage({ threadId: "t", role: "user", content: "old", tokenEstimate: 1 });
    const recent = ctx.mkMemory(3000);
    await recent.appendMessage({
      threadId: "t",
      role: "user",
      content: "recent",
      tokenEstimate: 1,
    });

    if (!recent.listObserverMessagesPage || !recent.appendObservationAndAdvanceFrontier) {
      throw new Error("adapter must implement bounded Observer paging");
    }
    const covered = await recent.listObserverMessagesPage({
      threadId: "t",
      accountId: "a",
      limit: 10,
      maxBytes: 10_000,
      maxTokens: 1_000,
    });
    const first = covered.messages[0];
    const last = covered.messages.at(-1);
    if (first === undefined || last === undefined || covered.nextCursor === null) {
      throw new Error("expected messages to cover");
    }
    await recent.appendObservationAndAdvanceFrontier({
      accountId: "a",
      observation: {
        threadId: "t",
        sourceMessageRange: [first.id, last.id],
        observationText: "covered",
        observedAt: new Date(3001),
      },
      expectedFrontier: covered.expectedFrontier,
      nextFrontier: covered.nextCursor,
    });

    const q = ctx.mkMemory(0);
    if (!q.countMessagesOlderThan || !q.selectMessagesOlderThan || !q.pruneMessagesOlderThan)
      throw new Error("adapter must implement memory_messages cleanup");

    expect(await q.countMessagesOlderThan(2000)).toBe(1); // only the t=1000 row
    expect(await q.countMessagesOlderThan(1000)).toBe(0); // strict: == cutoff survives

    const page = await q.selectMessagesOlderThan(2000, 10);
    expect(page).toHaveLength(1);
    expect(page[0]?.content).toBe("old");
    expect(page[0]?.createdAt).toBe(1000);

    expect(await q.pruneMessagesOlderThan(2000)).toBe(1);
    // The recent row (t=3000) survives.
    expect(await q.countMessagesOlderThan(9999)).toBe(1);
    if (!q.getMemoryAdminStats) throw new Error("missing getMemoryAdminStats");
    const stats = await q.getMemoryAdminStats({
      accountId: "a",
      threadId: "t",
      now: new Date(4000),
    });
    expect(stats.storage.messages).toBe(1);
    expect(stats.activity.lastMessageAt?.getTime()).toBe(3000);
  });

  it("memory_messages: keyset paging covers every eligible row exactly once", async () => {
    ctx = await open();
    const w = ctx.mkMemory(1000);
    await w.ensureThread({ id: "t", ownerId: "a" });
    for (let i = 0; i < 5; i++) {
      await w.appendMessage({ threadId: "t", role: "user", content: `m${i}`, tokenEstimate: 1 });
    }
    if (!w.listObserverMessagesPage || !w.appendObservationAndAdvanceFrontier) {
      throw new Error("adapter must implement bounded Observer paging");
    }
    const covered = await w.listObserverMessagesPage({
      threadId: "t",
      accountId: "a",
      limit: 10,
      maxBytes: 10_000,
      maxTokens: 1_000,
    });
    const first = covered.messages[0];
    const last = covered.messages.at(-1);
    if (first === undefined || last === undefined || covered.nextCursor === null) {
      throw new Error("expected messages to cover");
    }
    await w.appendObservationAndAdvanceFrontier({
      accountId: "a",
      observation: {
        threadId: "t",
        sourceMessageRange: [first.id, last.id],
        observationText: "covered",
        observedAt: new Date(1001),
      },
      expectedFrontier: covered.expectedFrontier,
      nextFrontier: covered.nextCursor,
    });
    const q = ctx.mkMemory(0);
    if (!q.selectMessagesOlderThan) throw new Error("missing selectMessagesOlderThan");
    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const pageRows = await q.selectMessagesOlderThan(2000, 2, after);
      if (pageRows.length === 0) break;
      for (const r of pageRows) seen.push(r.content);
      after = pageRows[pageRows.length - 1]?.id;
    }
    expect(seen.sort()).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("memory_messages: cleanup never deletes uncovered raw rows", async () => {
    ctx = await open();
    const w = ctx.mkMemory(1000);
    await w.ensureThread({ id: "uncovered", ownerId: "a" });
    await w.appendMessage({
      threadId: "uncovered",
      role: "user",
      content: "not formed yet",
      tokenEstimate: 4,
    });
    if (!w.countMessagesOlderThan || !w.pruneMessagesOlderThan) {
      throw new Error("missing memory cleanup methods");
    }
    expect(await w.countMessagesOlderThan(2000)).toBe(0);
    expect(await w.pruneMessagesOlderThan(2000)).toBe(0);
    expect(await w.listMessages({ threadId: "uncovered", accountId: "a" })).toHaveLength(1);
  });

  it("memory_jobs: prune deletes FINISHED rows older than the cutoff, never pending", async () => {
    ctx = await open();
    const w = ctx.mkMemory(5000);
    const doneId = await w.enqueueJob({
      type: "observer",
      scope: { accountId: "a", threadId: "t" },
    });
    await w.updateJobStatus(doneId, "done"); // updated_at = 5000
    await w.enqueueJob({ type: "reflector", scope: { accountId: "a" } }); // stays pending @5000

    const q = ctx.mkMemory(0);
    if (!q.pruneFinishedJobsOlderThan) throw new Error("missing pruneFinishedJobsOlderThan");
    // 4000 is below both rows → nothing deleted (strict + pending excluded).
    expect(await q.pruneFinishedJobsOlderThan(4000)).toBe(0);
    // 6000 deletes only the finished row; the pending reflector survives.
    expect(await q.pruneFinishedJobsOlderThan(6000)).toBe(1);
    const remaining = await q.claimPendingJobs(10);
    expect(remaining.map((j) => j.type)).toEqual(["reflector"]);
  });

  it("oauth_usage: count/prune use a STRICT older-than cutoff on bucket_ms", async () => {
    ctx = await open();
    const HOUR = 3_600_000;
    const h0 = Date.UTC(2026, 5, 3, 0);
    const h1 = h0 + HOUR;
    await ctx.usage.record({
      providerId: "p",
      account: "a",
      bucketMs: h0,
      tokens: 10,
      costUsd: null,
      nowMs: h0,
    });
    await ctx.usage.record({
      providerId: "p",
      account: "a",
      bucketMs: h1,
      tokens: 10,
      costUsd: null,
      nowMs: h1,
    });
    if (!ctx.usage.countUsageOlderThan || !ctx.usage.pruneUsageOlderThan)
      throw new Error("adapter must implement oauth_usage cleanup");

    expect(await ctx.usage.countUsageOlderThan(h1)).toBe(1); // strict: h0 only
    expect(await ctx.usage.pruneUsageOlderThan(h1)).toBe(1);
    expect(await ctx.usage.countUsageOlderThan(h1 + HOUR)).toBe(1); // h1 bucket remains
  });
});
