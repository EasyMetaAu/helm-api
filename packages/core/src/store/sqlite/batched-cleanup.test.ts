import { afterEach, describe, expect, it } from "vitest";
import { SQLITE_PRUNE_BATCH_SIZE } from "./batched-prune.js";
import { SqliteMemoryStore } from "./memory-store.js";
import { createSqliteDb } from "./migrate.js";
import { SqliteOAuthUsageStore } from "./oauth-usage.js";
import { SqliteTelemetryStore } from "./telemetry.js";

const dbs: ReturnType<typeof createSqliteDb>[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.$sqlite.close();
});

async function expectEventLoopYield(work: () => Promise<unknown>): Promise<void> {
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  await work();
  expect(yielded).toBe(true);
}

function seedExpiredRows() {
  const db = createSqliteDb(":memory:");
  dbs.push(db);
  const rows = SQLITE_PRUNE_BATCH_SIZE + 1;
  const insert = db.$sqlite.transaction(() => {
    for (let i = 0; i < rows; i += 1) {
      const id = `old-${i}`;
      db.$sqlite
        .prepare(
          "INSERT INTO telemetry (id, request_id, api_key_id, decision_json, created_at) VALUES (?, ?, 'key', '{}', 1000)",
        )
        .run(id, id);
      db.$sqlite
        .prepare(
          "INSERT INTO request_payloads (request_id, request_json, created_at) VALUES (?, '{}', 1000)",
        )
        .run(id);
      db.$sqlite
        .prepare(
          "INSERT INTO sessions (session_ref, account_id, api_key_id, source, external_session_id, created_at, last_seen_at) VALUES (?, 'account', 'key', 'header', ?, 1000, 1000)",
        )
        .run(id, id);
      db.$sqlite
        .prepare(
          "INSERT INTO session_revisions (request_id, session_ref, sequence, retain_count, request_delta_json, request_envelope_json, fidelity, created_at) VALUES (?, ?, 1, 1, '{}', '{}', 'semantic', 1000)",
        )
        .run(`revision-${id}`, id);
      db.$sqlite
        .prepare(
          "INSERT INTO memory_messages (id, thread_id, role, content, token_estimate, created_at) VALUES (?, 'thread', 'user', 'body', 1, 1000)",
        )
        .run(id);
      db.$sqlite
        .prepare(
          "INSERT INTO memory_observations (id, thread_id, source_message_range, observation_text, observed_at, status, archived_at) VALUES (?, 'thread', '[]', 'body', 1000, 'archived', 1000)",
        )
        .run(id);
      db.$sqlite
        .prepare(
          "INSERT INTO memory_facts (id, owner_id, subject_key, fact_text, content_hash, valid_from, expired_at, created_at, updated_at) VALUES (?, 'account', 'subject', 'fact', ?, 1000, 1000, 1000, 1000)",
        )
        .run(id, id);
      db.$sqlite
        .prepare(
          "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, 'observer', 'thread', 'done', 1000, 1000)",
        )
        .run(id);
      db.$sqlite
        .prepare(
          "INSERT INTO oauth_usage (provider_id, account, bucket_ms, requests, tokens, first_seen_ms, updated_at) VALUES ('provider', ?, 1000, 1, 1, 1000, 1000)",
        )
        .run(id);
    }
  });
  db.$sqlite
    .prepare(
      "INSERT INTO memory_threads (id, message_count, last_message_at, observation_count, created_at, updated_at) VALUES ('thread', ?, 1000, ?, 1000, 1000)",
    )
    .run(rows, rows);
  insert();
  return {
    db,
    rows,
    telemetry: new SqliteTelemetryStore(db),
    memory: new SqliteMemoryStore(db),
    oauth: new SqliteOAuthUsageStore(db),
  };
}

describe("SQLite retention cleanup", () => {
  it("prunes every cleanup action in small batches with event-loop yields", async () => {
    const { db, rows, telemetry, memory, oauth } = seedExpiredRows();

    await expectEventLoopYield(async () => expect(await telemetry.pruneTelemetry(2000)).toBe(rows));
    await expectEventLoopYield(async () => telemetry.prunePayloads(2000));
    await expectEventLoopYield(async () =>
      expect(await telemetry.pruneInactiveSessions(2000)).toBe(rows),
    );
    await expectEventLoopYield(async () =>
      expect(await memory.pruneMessagesOlderThan(2000)).toBe(rows),
    );
    await expectEventLoopYield(async () =>
      expect(await oauth.pruneUsageOlderThan(2000)).toBe(rows),
    );
    await expectEventLoopYield(async () =>
      expect(await memory.pruneFinishedJobsOlderThan(2000)).toBe(rows),
    );
    await expectEventLoopYield(async () =>
      expect(
        await memory.pruneExpiredMemory({
          archivedObservationsBeforeMs: 2000,
          expiredFactsBeforeMs: 2000,
        }),
      ).toEqual({ observationsDeleted: rows, factsDeleted: rows }),
    );

    expect(db.$sqlite.prepare("SELECT COUNT(*) AS value FROM session_revisions").get()).toEqual({
      value: 0,
    });
    expect(db.$sqlite.prepare("SELECT message_count AS value FROM memory_threads").get()).toEqual({
      value: 0,
    });
  });

  it("finishes a claimed expired session before admitting a reactivation", async () => {
    const db = createSqliteDb(":memory:");
    dbs.push(db);
    const telemetry = new SqliteTelemetryStore(db);
    const revisions = SQLITE_PRUNE_BATCH_SIZE * 2 + 1;
    db.$sqlite
      .prepare(
        "INSERT INTO sessions (session_ref, account_id, api_key_id, source, external_session_id, created_at, last_seen_at) VALUES ('old', 'account', 'key', 'header', 'old', 1000, 1000)",
      )
      .run();
    const insert = db.$sqlite.prepare(
      "INSERT INTO session_revisions (request_id, session_ref, sequence, retain_count, request_delta_json, request_envelope_json, fidelity, created_at) VALUES (?, 'old', ?, 1, '{}', '{}', 'semantic', 1000)",
    );
    db.$sqlite.transaction(() => {
      for (let sequence = 1; sequence <= revisions; sequence += 1) {
        insert.run(`revision-${sequence}`, sequence);
      }
    })();
    const reactivated = new Promise<void>((resolve, reject) => {
      setImmediate(async () => {
        try {
          await telemetry.upsertSessionRevision({
            sessionRef: "old",
            accountId: "account",
            apiKeyId: "key",
            source: "header",
            externalSessionId: "old",
            requestId: "reactivated",
            parentRequestId: `revision-${revisions}`,
            retainCount: 1,
            requestDeltaJson: "{}",
            requestEnvelopeJson: "{}",
            responseId: null,
            responseJson: null,
            fidelity: "semantic",
            createdAt: new Date(3000),
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    await expect(telemetry.pruneInactiveSessions(2000)).resolves.toBe(1);
    await reactivated;

    expect(db.$sqlite.prepare("SELECT COUNT(*) AS value FROM sessions").get()).toEqual({
      value: 1,
    });
    expect(
      db.$sqlite
        .prepare(
          "SELECT request_id AS requestId, parent_request_id AS parentRequestId FROM session_revisions",
        )
        .get(),
    ).toEqual({ requestId: "reactivated", parentRequestId: null });
  });

  it("rechecks a prune claim after an earlier writer yielded before its transaction", async () => {
    const db = createSqliteDb(":memory:");
    dbs.push(db);
    const telemetry = new SqliteTelemetryStore(db);
    const revisions = SQLITE_PRUNE_BATCH_SIZE * 2 + 1;
    db.$sqlite
      .prepare(
        "INSERT INTO sessions (session_ref, account_id, api_key_id, source, external_session_id, created_at, last_seen_at) VALUES ('old', 'account', 'key', 'header', 'old', 1000, 1000)",
      )
      .run();
    const insert = db.$sqlite.prepare(
      "INSERT INTO session_revisions (request_id, session_ref, sequence, retain_count, request_delta_json, request_envelope_json, fidelity, created_at) VALUES (?, 'old', ?, 1, '{}', '{}', 'semantic', 1000)",
    );
    db.$sqlite.transaction(() => {
      for (let sequence = 1; sequence <= revisions; sequence += 1) {
        insert.run(`revision-${sequence}`, sequence);
      }
    })();

    const reactivated = telemetry.upsertSessionRevision({
      sessionRef: "old",
      accountId: "account",
      apiKeyId: "key",
      source: "header",
      externalSessionId: "old",
      requestId: "reactivated",
      parentRequestId: `revision-${revisions}`,
      retainCount: 1,
      requestDeltaJson: "{}",
      requestEnvelopeJson: "{}",
      responseId: null,
      responseJson: null,
      fidelity: "semantic",
      createdAt: new Date(3000),
    });
    const pruned = telemetry.pruneInactiveSessions(2000);

    await expect(pruned).resolves.toBe(1);
    await reactivated;

    expect(
      db.$sqlite
        .prepare(
          "SELECT request_id AS requestId, parent_request_id AS parentRequestId FROM session_revisions",
        )
        .all(),
    ).toEqual([{ requestId: "reactivated", parentRequestId: null }]);
  });

  it("finishes a persisted session-prune claim before accepting new history", async () => {
    const db = createSqliteDb(":memory:");
    dbs.push(db);
    const telemetry = new SqliteTelemetryStore(db);
    db.$sqlite
      .prepare(
        "INSERT INTO sessions (session_ref, account_id, api_key_id, source, external_session_id, head_request_id, revision_count, created_at, last_seen_at) VALUES ('old', 'account', 'key', 'header', 'old', '__helm_pruning__', 2, 1000, 1000)",
      )
      .run();
    db.$sqlite
      .prepare(
        "INSERT INTO session_revisions (request_id, session_ref, sequence, retain_count, request_delta_json, request_envelope_json, fidelity, created_at) VALUES (?, 'old', ?, 1, '{}', '{}', 'semantic', 1000)",
      )
      .run("revision-1", 1);
    db.$sqlite
      .prepare(
        "INSERT INTO session_revisions (request_id, session_ref, sequence, retain_count, request_delta_json, request_envelope_json, fidelity, created_at) VALUES (?, 'old', ?, 1, '{}', '{}', 'semantic', 1000)",
      )
      .run("revision-2", 2);

    await telemetry.upsertSessionRevision({
      sessionRef: "old",
      accountId: "account",
      apiKeyId: "key",
      source: "header",
      externalSessionId: "old",
      requestId: "reactivated",
      parentRequestId: "revision-2",
      retainCount: 1,
      requestDeltaJson: "{}",
      requestEnvelopeJson: "{}",
      responseId: null,
      responseJson: null,
      fidelity: "semantic",
      createdAt: new Date(3000),
    });

    expect(
      db.$sqlite
        .prepare(
          "SELECT request_id AS requestId, parent_request_id AS parentRequestId FROM session_revisions",
        )
        .all(),
    ).toEqual([{ requestId: "reactivated", parentRequestId: null }]);
  });
});
