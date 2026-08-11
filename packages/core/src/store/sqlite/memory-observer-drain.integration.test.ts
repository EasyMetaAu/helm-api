import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryJobRow } from "@helm/shared";
import { describe, expect, it } from "vitest";
import type { ObserverDeps, ObserverJob } from "../../memory/observer.js";
import { runObserverJob } from "../../memory/observer.js";
import type { MemoryObserverCursor, MemoryObserverPage } from "../ports.js";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";

const ROW_COUNT = 51_116;
const PAGE_ROWS = 512;
const PAGE_BYTES = 1024 * 1024;
const PAGE_TOKENS = 64 * 1024;
const ROW_BYTES = PAGE_BYTES / PAGE_ROWS;
const ROW_TOKENS = PAGE_TOKENS / PAGE_ROWS;
const RSS_DRAIN_DELTA_LIMIT = 128 * 1024 * 1024;
const COVERED_ROWS = 20;

const NULL_PRICING = {
  modelKey: null,
  inputPerMtok: null,
  outputPerMtok: null,
  cacheReadPerMtok: null,
  cacheWritePerMtok: null,
  maxContextTokens: null,
};

function messageId(index: number): string {
  return `message-${String(index).padStart(6, "0")}`;
}

function compareCursor(left: MemoryObserverCursor, right: MemoryObserverCursor): number {
  return left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id);
}

function observerJob(claimed: MemoryJobRow): ObserverJob {
  const { accountId, threadId, projectId, resourceId } = claimed.scope;
  if (threadId === undefined) throw new Error("claimed Observer job has no thread");
  const lease = claimed as MemoryJobRow & { leaseGeneration?: number };
  return {
    jobId: claimed.jobId,
    accountId,
    threadId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(lease.leaseGeneration !== undefined ? { leaseGeneration: lease.leaseGeneration } : {}),
  } as ObserverJob;
}

function seedMessages(db: ReturnType<typeof createSqliteDb>, threadId: string): void {
  const insert = db.$sqlite.prepare(`INSERT INTO memory_messages
    (id, thread_id, role, content, token_estimate, created_at, message_index, content_hash)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`);
  const insertBatch = db.$sqlite.transaction((start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      const prefix = `${messageId(index)}:`;
      const content = prefix + "x".repeat(ROW_BYTES - prefix.length);
      insert.run(
        messageId(index),
        threadId,
        content,
        ROW_TOKENS,
        index + 1,
        index,
        `fixture-${index}`,
      );
    }
  });
  for (let start = 0; start < ROW_COUNT; start += 1_000) {
    insertBatch(start, Math.min(start + 1_000, ROW_COUNT));
  }
  db.$sqlite
    .prepare(
      `UPDATE memory_threads
          SET message_count = ?, last_message_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(ROW_COUNT, ROW_COUNT, ROW_COUNT, threadId);
}

function seedForgottenCoverage(
  db: ReturnType<typeof createSqliteDb>,
  threadId: string,
): Set<string> {
  const covered = new Set(Array.from({ length: COVERED_ROWS }, (_, index) => messageId(index)));
  const insert = db.$sqlite.prepare(`INSERT INTO memory_observations
    (id, thread_id, source_message_range, observation_text, observed_at,
     referenced_at, priority, tags, reference_count, importance, status, archived_at, expired_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 0.5, ?, ?, NULL)`);
  insert.run(
    "archived-coverage",
    threadId,
    JSON.stringify([messageId(0), messageId(9)]),
    "archived coverage",
    100,
    "archived",
    200,
  );
  insert.run(
    "pruned-coverage",
    threadId,
    JSON.stringify([messageId(10), messageId(19)]),
    "[pruned]",
    101,
    "pruned",
    201,
  );
  db.$sqlite
    .prepare(
      `UPDATE memory_threads SET observation_count = 2, last_observation_at = 101 WHERE id = ?`,
    )
    .run(threadId);
  return covered;
}

describe("SQLite Observer production-scale drain", () => {
  it("drains 51,116 real rows within every page/input/RSS bound and resumes a crashed claim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-observer-drain-"));
    const db = createSqliteDb(join(dir, "observer.db"));
    let sequence = 0;
    let nowMs = 10_000_000;
    const store = new SqliteMemoryStore(
      db,
      () => `generated-${++sequence}`,
      () => new Date(nowMs),
    );
    const scope = { accountId: "observer-drain-account", threadId: "observer-drain-thread" };

    try {
      await store.ensureThread({ id: scope.threadId, ownerId: scope.accountId });
      seedMessages(db, scope.threadId);
      const forgottenIds = seedForgottenCoverage(db, scope.threadId);
      expect(
        (db.$sqlite.prepare(`SELECT COUNT(*) AS n FROM memory_messages`).get() as { n: number }).n,
      ).toBe(ROW_COUNT);

      // Keep SQLite's own cache out of the JS-drain RSS assertion.
      db.$sqlite.pragma("cache_size = -8192");
      db.$sqlite.pragma("shrink_memory");
      const rssBaseline = process.memoryUsage().rss;
      let maxRss = rssBaseline;
      let previousFrontier: MemoryObserverCursor | null = null;
      let pageCount = 0;
      let pageMessageCount = 0;
      let summaryMessageCount = 0;
      let maxSummaryMessages = 0;
      let maxSummaryBytes = 0;
      let maxSummaryTokens = 0;
      let coveragePortSeen = false;

      const readPage = store.listObserverMessagesPage.bind(store);
      store.listObserverMessagesPage = async (input): Promise<MemoryObserverPage> => {
        const page = await readPage(input);
        const pageBytes = page.messages.reduce(
          (sum, message) => sum + Buffer.byteLength(message.content, "utf8"),
          0,
        );
        const pageTokens = page.messages.reduce((sum, message) => sum + message.tokenEstimate, 0);
        expect(page.messages.length).toBeLessThanOrEqual(PAGE_ROWS);
        expect(pageBytes).toBeLessThanOrEqual(PAGE_BYTES);
        expect(pageTokens).toBeLessThanOrEqual(PAGE_TOKENS);
        if (page.messages.length > 0) {
          expect(page.expectedFrontier).toEqual(previousFrontier);
          expect(page.nextCursor).not.toBeNull();
          if (page.nextCursor === null) throw new Error("non-empty Observer page has no cursor");
          if (previousFrontier !== null) {
            expect(compareCursor(page.nextCursor, previousFrontier)).toBeGreaterThan(0);
          }
          previousFrontier = page.nextCursor;
          pageCount += 1;
          pageMessageCount += page.messages.length;
        }
        const coveredMessageIds = (page as MemoryObserverPage & { coveredMessageIds?: string[] })
          .coveredMessageIds;
        if (coveredMessageIds !== undefined) {
          coveragePortSeen = true;
          expect(coveredMessageIds.length).toBeLessThanOrEqual(page.messages.length);
        }
        maxRss = Math.max(maxRss, process.memoryUsage().rss);
        return page;
      };

      const deps: ObserverDeps = {
        memoryStore: store,
        summarize: async ({ messages }) => {
          const inputBytes = messages.reduce(
            (sum, message) => sum + Buffer.byteLength(message.content, "utf8"),
            0,
          );
          const inputTokens = messages.reduce((sum, message) => sum + message.tokenEstimate, 0);
          expect(messages.length).toBeLessThanOrEqual(PAGE_ROWS);
          expect(inputBytes).toBeLessThanOrEqual(PAGE_BYTES);
          expect(inputTokens).toBeLessThanOrEqual(PAGE_TOKENS);
          if (coveragePortSeen) {
            expect(messages.some((message) => forgottenIds.has(message.id))).toBe(false);
          }
          summaryMessageCount += messages.length;
          maxSummaryMessages = Math.max(maxSummaryMessages, messages.length);
          maxSummaryBytes = Math.max(maxSummaryBytes, inputBytes);
          maxSummaryTokens = Math.max(maxSummaryTokens, inputTokens);
          maxRss = Math.max(maxRss, process.memoryUsage().rss);
          return { observationText: `bounded page ${summaryMessageCount}` };
        },
        costSink: () => {},
        resolvePricing: () => NULL_PRICING,
        now: () => new Date(nowMs),
        log: () => {},
      };

      const jobId = await store.enqueueJob({ type: "observer", scope });
      expect((await store.claimPendingJobs(1))[0]?.jobId).toBe(jobId);
      nowMs += 6 * 60_000;
      const reclaimed = (await store.claimPendingJobs(1))[0];
      expect(reclaimed?.jobId).toBe(jobId);
      if (reclaimed === undefined) throw new Error("stale Observer job was not reclaimed");
      let claimed = reclaimed;

      for (;;) {
        const result = await runObserverJob(observerJob(claimed), deps);
        expect(result.observationId).not.toBeNull();
        const next = await store.claimPendingJobs(1);
        if (next.length === 0) break;
        const nextClaimed = next[0];
        if (nextClaimed === undefined) throw new Error("non-empty claim page has no job");
        claimed = nextClaimed;
        expect(claimed.type).toBe("observer");
        expect(pageCount).toBeLessThanOrEqual(Math.ceil(ROW_COUNT / PAGE_ROWS));
      }

      const drained = await readPage({
        ...scope,
        limit: PAGE_ROWS,
        maxBytes: PAGE_BYTES,
        maxTokens: PAGE_TOKENS,
      });
      expect(drained.messages).toEqual([]);
      expect(drained.expectedFrontier).toEqual(previousFrontier);
      expect(pageMessageCount).toBe(ROW_COUNT);
      expect(summaryMessageCount).toBe(coveragePortSeen ? ROW_COUNT - COVERED_ROWS : ROW_COUNT);
      expect(pageCount).toBe(Math.ceil(ROW_COUNT / PAGE_ROWS));
      expect(maxSummaryMessages).toBe(PAGE_ROWS);
      expect(maxSummaryBytes).toBe(PAGE_BYTES);
      expect(maxSummaryTokens).toBe(PAGE_TOKENS);
      expect(maxRss - rssBaseline).toBeLessThan(RSS_DRAIN_DELTA_LIMIT);

      const forgotten = db.$sqlite
        .prepare(
          `SELECT id, status, observation_text FROM memory_observations
              WHERE id IN ('archived-coverage', 'pruned-coverage') ORDER BY id`,
        )
        .all() as Array<{ id: string; status: string; observation_text: string }>;
      expect(forgotten).toEqual([
        { id: "archived-coverage", status: "archived", observation_text: "archived coverage" },
        { id: "pruned-coverage", status: "pruned", observation_text: "[pruned]" },
      ]);
    } finally {
      db.$sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
