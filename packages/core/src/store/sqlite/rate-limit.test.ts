import type { RateLimitConfig } from "@helm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createRateLimiter } from "../../ratelimit/limiter.js";
import type { RateLimitStore } from "../ports.js";
import { createSqliteDb, type SqliteDb } from "./migrate.js";
import { SqliteRateLimitStore } from "./rate-limit.js";
import { InMemoryRateLimitStore } from "./rate-limit-memory.js";

// Same port contract, two adapters. (No supabase adapter exists in this repo yet
// — see implementation-notes; the in-memory adapter stands in as the second
// implementation proving the port is implementation-agnostic.)
const adapters: Array<{ name: string; make: () => { store: RateLimitStore; close: () => void } }> =
  [
    {
      name: "in-memory",
      make: () => ({ store: new InMemoryRateLimitStore(), close: () => {} }),
    },
    {
      name: "sqlite",
      make: () => {
        const db = createSqliteDb(":memory:");
        return { store: new SqliteRateLimitStore(db), close: () => db.$sqlite.close() };
      },
    },
  ];

function cfg(over: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return { enabled: true, default: { rpm: 2, tpm: 0 }, overrides: {}, ...over };
}

describe.each(adapters)("RateLimitStore contract — $name", ({ make }) => {
  let handle: { store: RateLimitStore; close: () => void };
  afterEach(() => handle?.close());

  it("consume decrements and rejects when empty", async () => {
    handle = make();
    const a = await handle.store.consume("k1", "rpm", null, 2, 1, 0);
    expect(a.ok).toBe(true);
    expect(a.remaining).toBe(1);
    const b = await handle.store.consume("k1", "rpm", a.state, 2, 1, 0);
    expect(b.ok).toBe(true);
    expect(b.remaining).toBe(0);
    const c = await handle.store.consume("k1", "rpm", b.state, 2, 1, 0);
    expect(c.ok).toBe(false);
  });

  it("persists window state across a fresh limiter (simulated restart)", async () => {
    handle = make();
    const l1 = createRateLimiter({ config: cfg(), store: handle.store });
    expect((await l1.check({ keyId: "k1", estimatedTokens: 0, now: 0 })).allowed).toBe(true);
    expect((await l1.check({ keyId: "k1", estimatedTokens: 0, now: 0 })).allowed).toBe(true);
    // Rebuild the limiter over the SAME store: counters must continue, not reset.
    const l2 = createRateLimiter({ config: cfg(), store: handle.store });
    expect((await l2.check({ keyId: "k1", estimatedTokens: 0, now: 0 })).allowed).toBe(false);
  });
});

describe("SqliteRateLimitStore — survives a DB reopen on a real file", () => {
  let dbPath: string;
  let db: SqliteDb | null = null;

  afterEach(() => {
    db?.$sqlite.close();
  });

  it("continues the window after closing and reopening the file", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helm-rl-")), "rl.db");

    db = createSqliteDb(dbPath);
    const s1 = new SqliteRateLimitStore(db);
    const l1 = createRateLimiter({ config: cfg(), store: s1 });
    await l1.check({ keyId: "k1", estimatedTokens: 0, now: 0 });
    await l1.check({ keyId: "k1", estimatedTokens: 0, now: 0 });
    db.$sqlite.close();

    // Reopen: a new process would see the persisted bucket and continue limiting.
    db = createSqliteDb(dbPath);
    const s2 = new SqliteRateLimitStore(db);
    const l2 = createRateLimiter({ config: cfg(), store: s2 });
    expect((await l2.check({ keyId: "k1", estimatedTokens: 0, now: 0 })).allowed).toBe(false);
  });
});
