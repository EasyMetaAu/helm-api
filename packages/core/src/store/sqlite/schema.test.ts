import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
  projectScopedThreadId,
  quarantinedMalformedJobThreadId,
  quarantinedParentThreadId,
  quarantinedRawThreadId,
} from "../../memory/thread-scope.js";
import { createSqliteDb, runMigrations } from "./migrate.js";
import { apiKeys, rateLimitBuckets, routingSignals } from "./schema.js";

describe("sqlite schema + migrations", () => {
  it("applies cleanly to a fresh db and is idempotent on re-run", () => {
    // Use a real temp file so the second runMigrations() sees the first's state
    // (":memory:" is a brand-new db each call, which would not test idempotency).
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-"));
    const path = join(dir, "helm.db");
    try {
      expect(() => {
        runMigrations(path);
        runMigrations(path);
        runMigrations(path);
      }).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v49 reconciles stale Memory counters without skipping uncovered legacy raw history", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v49-memory-frontier-"));
    const path = join(dir, "helm.db");
    try {
      runMigrations(path);
      const seed = new Database(path);
      seed.exec(`
        INSERT INTO memory_threads (
          id, owner_id, message_count, last_message_at,
          observation_count, created_at, updated_at
        ) VALUES ('t', 'a', 999, 9999, 999, 1, 1);
        INSERT INTO memory_messages (
          id, thread_id, role, content, token_estimate, created_at
        ) VALUES ('m1', 't', 'user', 'one', 1, 1000),
                 ('m2', 't', 'assistant', 'two', 1, 2000);
        INSERT INTO memory_observations (
          id, thread_id, source_message_range, observation_text, observed_at
        ) VALUES ('o1', 't', '["m1","m2"]', 'summary', 3000);
        DELETE FROM _migrations WHERE version = 49;
      `);
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      expect(
        after
          .prepare(
            `SELECT message_count, last_message_at, observation_count,
                    last_observation_at, observer_frontier_at, observer_frontier_id
               FROM memory_threads WHERE id = 't'`,
          )
          .get(),
      ).toEqual({
        message_count: 2,
        last_message_at: 2000,
        observation_count: 1,
        last_observation_at: 3000,
        observer_frontier_at: null,
        observer_frontier_id: null,
      });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v50 preserves existing jobs and initializes their lease generation to zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v50-job-lease-"));
    const path = join(dir, "helm.db");
    try {
      runMigrations(path);
      const seed = new Database(path);
      seed.exec(`
        INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at)
        VALUES ('legacy', 'observer', '{"accountId":"a","threadId":"t"}', 'pending', 1, 1);
        ALTER TABLE memory_jobs DROP COLUMN lease_generation;
        DELETE FROM _migrations WHERE version = 50;
      `);
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      expect(
        after.prepare("SELECT status, lease_generation FROM memory_jobs WHERE id = 'legacy'").get(),
      ).toEqual({ status: "pending", lease_generation: 0 });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v51 preserves reset rows and marks legacy boundaries exact", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v51-reset-estimates-"));
    const path = join(dir, "helm.db");
    try {
      runMigrations(path);
      const seed = new Database(path);
      seed.exec(`
        INSERT INTO oauth_reset_period (
          provider_id, account, window_key, period_start_ms, period_end_ms, detected_at_ms
        ) VALUES ('openai-codex', 'a', 'primary', 1, 2, 2);
        ALTER TABLE oauth_reset_period DROP COLUMN approximate;
        DELETE FROM _migrations WHERE version = 51;
      `);
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      expect(after.prepare("SELECT approximate FROM oauth_reset_period").get()).toEqual({
        approximate: 0,
      });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a real pre-unique-index memory_jobs table with duplicate open jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v13-memory-jobs-"));
    const path = join(dir, "helm.db");
    const scope = JSON.stringify({ accountId: "acct-a", threadId: "t1" });
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      seed.exec(`
        CREATE TABLE memory_jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      // Seed everything EXCEPT the memory migrations (v14–v16) as applied, so
      // only they run — the minimal seed has no api_keys table for v10–v13/v17/v19,
      // and no memory_observations/reflections tables for the v18 forgetting
      // deltas, so both are pre-marked applied to keep this test scoped to v14–v16.
      // v20 (memory_threads.last_served_model) is also pre-marked: this fixture
      // never creates memory_threads (v2 is marked applied without the CREATE),
      // so the v20 ALTER would fail — out of scope for this v14–v16 test.
      // v21 (memory_messages dedup) likewise: v2 is applied without the
      // memory_messages CREATE, so its dedup DELETE would fail — out of scope.
      // v22 (telemetry token columns): this fixture never creates telemetry, so the
      // ALTER would fail — pre-mark applied, out of scope for this v14–v16 test.
      // v23 (oauth_usage day→bucket_ms): v12 is applied without the oauth_usage
      // CREATE, so the RENAME would fail — pre-mark applied, out of scope.
      // v24 adds request_payloads.upstream_request_json; this memory_jobs fixture
      // never creates request_payloads → pre-mark applied (out of scope).
      // v25 (telemetry.generation_ms): no telemetry table here → pre-mark applied.
      // v26 alters oauth_quota (created at v12, applied here without the CREATE) →
      // pre-mark applied, out of scope.
      // v28 alters memory_facts (+ FTS); this memory_jobs-only fixture never creates
      // memory_facts → pre-mark applied (out of scope for this v14–v16 test).
      // v30/v32/v37 alter telemetry and v31 alters api_keys; both tables are absent from
      // this memory_jobs-only fixture → pre-mark applied. v29 (payload_blobs CREATE)
      // has no dependency but is pre-marked too.
      // biome-ignore format: keep the version ledger on one readable line
      for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28, 29, 30, 31, 32, 37])
        rec.run(v, Date.now());
      const insert = seed.prepare(
        "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run("keep-earliest", "observer", scope, "pending", 100, 100);
      insert.run("close-pending", "observer", scope, "pending", 200, 200);
      insert.run("close-running", "observer", scope, "running", 300, 300);
      seed.close();

      expect(() => runMigrations(path)).not.toThrow();

      const after = new Database(path);
      const openRows = after
        .prepare(
          "SELECT id, status FROM memory_jobs WHERE type = ? AND scope_id = ? AND status IN ('pending','running') ORDER BY created_at, id",
        )
        .all("observer", scope) as Array<{ id: string; status: string }>;
      expect(openRows).toEqual([{ id: "keep-earliest", status: "pending" }]);
      const closedRows = after
        .prepare(
          "SELECT id, status, error FROM memory_jobs WHERE id IN ('close-pending','close-running')",
        )
        .all() as Array<{ id: string; status: string; error: string }>;
      expect(closedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "close-pending", status: "failed" }),
          expect.objectContaining({ id: "close-running", status: "failed" }),
        ]),
      );
      expect(closedRows.every((r) => r.error.includes("migration cleanup"))).toBe(true);
      expect(() =>
        after
          .prepare(
            "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("blocked-by-index", "observer", scope, "pending", 400, 400),
      ).toThrow();
      after.prepare("UPDATE memory_jobs SET status = 'done' WHERE id = 'keep-earliest'").run();
      expect(() =>
        after
          .prepare(
            "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("new-open-after-done", "observer", scope, "pending", 500, 500),
      ).not.toThrow();
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates api_keys and telemetry with the expected columns", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const keyCols = raw
      .prepare("PRAGMA table_info(api_keys)")
      .all()
      .map((c) => (c as { name: string }).name);
    const telCols = raw
      .prepare("PRAGMA table_xinfo(telemetry)")
      .all()
      .map((c) => (c as { name: string }).name);
    const sessionRevisionCols = raw
      .prepare("PRAGMA table_info(session_revisions)")
      .all()
      .map((c) => (c as { name: string }).name);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const c of [
      "key_id",
      "hash",
      "prefix",
      "secret_enc",
      "account_id",
      "role",
      "allowed_lanes",
      "allow_custom_model",
      "blocked_models",
      "allow_fast_mode",
      "request_content_mode",
      "disabled",
      "created_at",
    ]) {
      expect(keyCols).toContain(c);
    }
    // max_lane was retired in v10 (drop column) — the ceiling is subsumed by
    // the allowed_lanes whitelist, so it must NOT survive on a fully migrated DB.
    expect(keyCols).not.toContain("max_lane");
    for (const c of [
      "id",
      "request_id",
      "api_key_id",
      "decision_json",
      "final_status",
      "cost_usd",
      "latency_total_ms",
      "prompt_tokens",
      "completion_tokens",
      "cached_tokens",
      "cache_creation_tokens",
      "served_model",
      "generation_ms",
      "model_search",
      "created_at",
    ]) {
      expect(telCols).toContain(c);
    }
    for (const c of [
      "request_id",
      "session_ref",
      "parent_request_id",
      "retain_count",
      "request_delta_json",
      "request_envelope_json",
      "body_bytes",
      "request_body_generation",
      "response_body_generation",
      "response_id",
      "response_json",
      "fidelity",
    ]) {
      expect(sessionRevisionCols).toContain(c);
    }
    expect(tables).toContain("session_head_event_hashes");
    expect(tables).toContain("session_revision_body_chunks");
    const telemetryIndexes = raw
      .prepare("PRAGMA index_list(telemetry)")
      .all()
      .map((idx) => (idx as { name: string }).name);
    expect(telemetryIndexes).toContain("idx_telemetry_admin_window_cover");
    expect(telemetryIndexes).toContain("idx_telemetry_admin_key_window_cover");
    expect(telemetryIndexes).toContain("idx_telemetry_admin_model_window");
    expect(telemetryIndexes).toContain("idx_telemetry_admin_key_model_window");
    expect(telemetryIndexes).toContain("idx_telemetry_session_window");
    raw
      .prepare(
        "INSERT INTO sessions (session_ref, account_id, api_key_id, source, external_session_id, created_at, last_seen_at) VALUES ('s-check', 'acct', 'key', 'test', 'external', 1, 1)",
      )
      .run();
    const insertRevision = raw.prepare(
      "INSERT INTO session_revisions (request_id, session_ref, sequence, retain_count, request_delta_json, request_envelope_json, fidelity, created_at) VALUES (?, 's-check', ?, ?, '[]', '{}', 'semantic', 1)",
    );
    expect(() => insertRevision.run("r-valid", 1, 0)).not.toThrow();
    expect(() => insertRevision.run("r-negative", 2, -1)).toThrow();
    expect(() => insertRevision.run("r-fractional", 2, 1.5)).toThrow();
    raw
      .prepare(
        "INSERT INTO session_revision_body_chunks (request_id, generation, part, chunk_index, codec, raw_bytes, bytes, created_at) VALUES ('r-valid', 'g1', 'request_delta', 0, 'raw', 2, x'7b7d', 1)",
      )
      .run();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO session_revision_body_chunks (request_id, generation, part, chunk_index, codec, raw_bytes, bytes, created_at) VALUES ('r-valid', 'g1', 'invalid', 1, 'raw', 2, x'7b7d', 1)",
        )
        .run(),
    ).toThrow();
    raw.prepare("DELETE FROM session_revisions WHERE request_id = 'r-valid'").run();
    expect(raw.prepare("SELECT COUNT(*) AS count FROM session_revision_body_chunks").get()).toEqual(
      { count: 1 },
    );
    raw.close();
  });

  it("v45 adds empty Session chunk storage without scanning old bodies", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v42-session-bytes-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(`
        CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE session_revisions (
          request_id TEXT PRIMARY KEY,
          session_ref TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          parent_request_id TEXT,
          retain_count INTEGER NOT NULL,
          request_delta_json TEXT NOT NULL,
          request_envelope_json TEXT NOT NULL,
          response_id TEXT,
          response_json TEXT,
          fidelity TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO session_revisions
          (request_id, session_ref, sequence, retain_count, request_delta_json,
           request_envelope_json, response_json, fidelity, created_at)
        VALUES ('r1', 's1', 1, 0, '["\u4f60\u597d"]', '{"model":"x"}', NULL, 'semantic', 1);
      `);
      const record = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      for (let version = 1; version <= 41; version++) record.run(version, 1);
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      expect(after.prepare("SELECT body_bytes AS bodyBytes FROM session_revisions").get()).toEqual({
        bodyBytes: null,
      });
      const schemaSql = (
        after.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_revisions'").get() as {
          sql: string;
        }
      ).sql;
      expect(schemaSql).toContain("body_bytes INTEGER");
      expect(schemaSql).not.toContain("body_bytes INTEGER CHECK");
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v44 adds a nullable per-key request-content override", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v44-key-content-mode-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(`
        CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE api_keys (key_id TEXT PRIMARY KEY);
        INSERT INTO api_keys (key_id) VALUES ('legacy');
      `);
      const record = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      for (let version = 1; version <= 43; version++) record.run(version, 1);
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      const row = after
        .prepare("SELECT request_content_mode FROM api_keys WHERE key_id = 'legacy'")
        .get() as { request_content_mode: string | null };
      expect(row.request_content_mode).toBeNull();
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v45 adds empty chunk tables without touching legacy Session bodies", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v45-session-chunks-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE sessions (
          session_ref TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          api_key_id TEXT NOT NULL,
          source TEXT NOT NULL,
          external_session_id TEXT NOT NULL,
          head_request_id TEXT,
          revision_count INTEGER NOT NULL DEFAULT 0,
          stored_bytes INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE session_revisions (
          request_id TEXT PRIMARY KEY,
          session_ref TEXT NOT NULL REFERENCES sessions(session_ref) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          parent_request_id TEXT,
          retain_count INTEGER NOT NULL,
          request_delta_json TEXT NOT NULL,
          request_envelope_json TEXT NOT NULL,
          body_bytes INTEGER,
          response_id TEXT,
          response_json TEXT,
          fidelity TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO sessions
          (session_ref, account_id, api_key_id, source, external_session_id, created_at, last_seen_at)
        VALUES ('s1', 'a1', 'k1', 'test', 'external', 1, 1);
        INSERT INTO session_revisions
          (request_id, session_ref, sequence, retain_count, request_delta_json,
           request_envelope_json, response_json, fidelity, created_at)
        VALUES ('r1', 's1', 1, 0, '["legacy"]', '{"model":"x"}', '{"ok":true}', 'semantic', 1);
        CREATE TRIGGER forbid_legacy_session_update
          BEFORE UPDATE ON session_revisions BEGIN SELECT RAISE(ABORT, 'legacy row touched'); END;
        CREATE TRIGGER forbid_legacy_session_delete
          BEFORE DELETE ON session_revisions BEGIN SELECT RAISE(ABORT, 'legacy row touched'); END;
      `);
      const record = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      for (let version = 1; version <= 44; version++) record.run(version, 1);
      seed.close();

      expect(() => runMigrations(path)).not.toThrow();

      const after = new Database(path);
      expect(
        after
          .prepare(
            "SELECT request_delta_json, request_envelope_json, response_json, body_bytes FROM session_revisions WHERE request_id = 'r1'",
          )
          .get(),
      ).toEqual({
        request_delta_json: '["legacy"]',
        request_envelope_json: '{"model":"x"}',
        response_json: '{"ok":true}',
        body_bytes: null,
      });
      expect(
        after.prepare("SELECT COUNT(*) AS count FROM session_revision_body_chunks").get(),
      ).toEqual({ count: 0 });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v39 adds and backfills per-thread admin activity summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v39-memory-activity-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      seed.exec(`
        CREATE TABLE memory_threads (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          resource_id TEXT,
          owner_id TEXT,
          last_served_model TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE memory_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          message_index INTEGER,
          content_hash TEXT
        );
        CREATE INDEX idx_memory_messages_thread ON memory_messages (thread_id, created_at);
        CREATE TABLE memory_observations (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          source_message_range TEXT NOT NULL,
          observation_text TEXT NOT NULL,
          observed_at INTEGER NOT NULL
        );
        CREATE INDEX idx_memory_observations_thread ON memory_observations (thread_id, observed_at);
        INSERT INTO memory_threads (id, owner_id, created_at, updated_at)
          VALUES ('t1', 'a', 100, 100), ('empty', 'a', 100, 100);
        INSERT INTO memory_messages (id, thread_id, role, content, token_estimate, created_at)
          VALUES ('m1', 't1', 'user', 'one', 1, 1000),
                 ('m2', 't1', 'assistant', 'two', 1, 2000);
        INSERT INTO memory_observations
          (id, thread_id, source_message_range, observation_text, observed_at)
          VALUES ('o1', 't1', '["m1","m2"]', 'summary', 3000);
      `);
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      for (let version = 1; version <= 38; version++) rec.run(version, 1000);
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      const rows = after
        .prepare(
          `SELECT id, message_count, last_message_at, observation_count, last_observation_at
             FROM memory_threads ORDER BY id`,
        )
        .all();
      expect(rows).toEqual([
        {
          id: quarantinedParentThreadId("a", "empty"),
          message_count: 0,
          last_message_at: null,
          observation_count: 0,
          last_observation_at: null,
        },
        {
          id: quarantinedParentThreadId("a", "t1"),
          message_count: 2,
          last_message_at: 2000,
          observation_count: 1,
          last_observation_at: 3000,
        },
      ]);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v40 rewrites legacy memory thread ids and every reference atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v40-memory-thread-scope-"));
    const path = join(dir, "helm.db");
    const existingV2 = projectScopedThreadId("acct", "existing-project", "existing-thread");
    const expectedLegacy = quarantinedParentThreadId("acct", "acct:thread-one");
    const expectedNull = quarantinedParentThreadId("acct", "acct:thread-null");
    const expectedOpaqueV2 = quarantinedParentThreadId("acct", existingV2);
    const expectedDerivedLegacy = quarantinedRawThreadId("acct", "acct:thread-one");
    const expectedDerivedV2 = quarantinedRawThreadId("acct", existingV2);
    const expectedRaw = quarantinedRawThreadId("acct", "acct:manual");
    const expectedRawV2 = quarantinedRawThreadId("acct", "v2:n:manual");
    const expectedBroad = quarantinedRawThreadId("acct", "");
    try {
      const seed = new Database(path);
      seed.pragma("foreign_keys = ON");
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      seed.exec(`
        CREATE TABLE memory_threads (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          resource_id TEXT,
          owner_id TEXT,
          last_served_model TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          last_message_at INTEGER,
          observation_count INTEGER NOT NULL DEFAULT 0,
          last_observation_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE memory_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES memory_threads(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          message_index INTEGER,
          content_hash TEXT
        );
        CREATE TABLE memory_observations (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES memory_threads(id),
          source_message_range TEXT NOT NULL,
          observation_text TEXT NOT NULL,
          observed_at INTEGER NOT NULL
        );
        CREATE TABLE memory_reflections (
          id TEXT PRIMARY KEY,
          owner_id TEXT,
          project_id TEXT,
          resource_id TEXT,
          thread_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE memory_facts (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          project_id TEXT,
          resource_id TEXT,
          thread_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          invalid_at INTEGER,
          expired_at INTEGER,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE memory_jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        INSERT INTO memory_threads
          (id, project_id, resource_id, owner_id, message_count, observation_count, created_at, updated_at)
        VALUES
          ('acct:thread-one', 'project-α', 'legacy-resource', 'acct', 1, 1, 1, 2),
          ('acct:thread-null', NULL, NULL, 'acct', 1, 0, 3, 4),
          ('${existingV2}', 'existing-project', 'existing-resource', 'acct', 0, 0, 5, 6);
        INSERT INTO memory_messages
          (id, thread_id, role, content, token_estimate, created_at)
        VALUES
          ('m1', 'acct:thread-one', 'user', 'one', 1, 10),
          ('m2', 'acct:thread-null', 'user', 'null', 1, 11);
        INSERT INTO memory_observations
          (id, thread_id, source_message_range, observation_text, observed_at)
        VALUES ('o1', 'acct:thread-one', '["m1","m1"]', 'summary', 12);
        INSERT INTO memory_reflections (id, owner_id, project_id, resource_id, thread_id) VALUES
          ('r1', 'acct', 'project-α', 'legacy-resource', 'acct:thread-one'),
          ('r-raw', 'acct', 'project-α', 'manual-resource', 'acct:manual'),
          ('r-v2', 'acct', 'existing-project', 'existing-resource', '${existingV2}'),
          ('r-broad', 'acct', 'project-α', NULL, NULL),
          ('r-other', 'other', 'other-project', NULL, 'acct:thread-one');
        INSERT INTO memory_facts (id, owner_id, project_id, resource_id, thread_id) VALUES
          ('f1', 'acct', 'project-α', 'legacy-resource', 'acct:thread-one'),
          ('f-raw', 'acct', 'project-α', 'manual-resource', 'v2:n:manual'),
          ('f-v2', 'acct', 'existing-project', 'existing-resource', '${existingV2}'),
          ('f-broad', 'acct', 'project-α', NULL, NULL),
          ('f-other', 'other', 'other-project', NULL, 'acct:thread-one');
        INSERT INTO memory_jobs
          (id, type, scope_id, status, error, created_at, updated_at)
        VALUES
          ('j1', 'observer', '{"accountId":"acct","projectId":"project-α","resourceId":"legacy-resource","threadId":"acct:thread-one"}', 'pending', NULL, 1, 1),
          ('j2', 'observer', '{"accountId":"acct","threadId":"acct:thread-null"}', 'done', NULL, 1, 1),
          ('j-target', 'observer', '{"accountId":"acct","threadId":"${expectedLegacy}"}', 'pending', NULL, 1, 1),
          ('j-reflector', 'reflector', '{"accountId":"acct","projectId":"project-α"}', 'running', NULL, 1, 1),
          ('j-corrupt', 'observer', 's1', 'pending', NULL, 1, 1),
          ('j-corrupt-done', 'observer', '{bad', 'done', 'legacy error', 1, 1),
          ('j-shape', 'observer', '{"accountId":42,"threadId":[]}', 'running', NULL, 1, 1),
          ('j-other', 'observer', '{"accountId":"other","threadId":"acct:thread-one"}', 'pending', NULL, 1, 1);
        CREATE UNIQUE INDEX uniq_memory_jobs_open_type_scope
          ON memory_jobs (type, scope_id)
          WHERE status IN ('pending', 'running');
      `);
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      for (let version = 1; version <= 39; version++) rec.run(version, 1000);
      seed.close();

      runMigrations(path);
      runMigrations(path);

      const after = new Database(path);
      after.pragma("foreign_keys = ON");
      expect(
        after.prepare("SELECT id, project_id, resource_id FROM memory_threads ORDER BY id").all(),
      ).toEqual(
        [
          { id: expectedLegacy, project_id: null, resource_id: null },
          { id: expectedNull, project_id: null, resource_id: null },
          { id: expectedOpaqueV2, project_id: null, resource_id: null },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(after.prepare("SELECT id, thread_id FROM memory_messages ORDER BY id").all()).toEqual([
        { id: "m1", thread_id: expectedLegacy },
        { id: "m2", thread_id: expectedNull },
      ]);
      expect(
        after.prepare("SELECT thread_id FROM memory_observations WHERE id='o1'").get(),
      ).toEqual({
        thread_id: expectedLegacy,
      });
      expect(
        after
          .prepare(
            "SELECT id, project_id, resource_id, thread_id, status FROM memory_reflections ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: "r-broad",
          project_id: null,
          resource_id: null,
          thread_id: expectedBroad,
          status: "archived",
        },
        {
          id: "r-other",
          project_id: "other-project",
          resource_id: null,
          thread_id: "acct:thread-one",
          status: "active",
        },
        {
          id: "r-raw",
          project_id: null,
          resource_id: null,
          thread_id: expectedRaw,
          status: "archived",
        },
        {
          id: "r-v2",
          project_id: null,
          resource_id: null,
          thread_id: expectedDerivedV2,
          status: "archived",
        },
        {
          id: "r1",
          project_id: null,
          resource_id: null,
          thread_id: expectedDerivedLegacy,
          status: "archived",
        },
      ]);
      expect(
        after
          .prepare(
            "SELECT id, project_id, resource_id, thread_id, status, invalid_at, expired_at FROM memory_facts ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: "f-broad",
          project_id: null,
          resource_id: null,
          thread_id: expectedBroad,
          status: "archived",
          invalid_at: expect.any(Number),
          expired_at: expect.any(Number),
        },
        {
          id: "f-other",
          project_id: "other-project",
          resource_id: null,
          thread_id: "acct:thread-one",
          status: "active",
          invalid_at: null,
          expired_at: null,
        },
        {
          id: "f-raw",
          project_id: null,
          resource_id: null,
          thread_id: expectedRawV2,
          status: "archived",
          invalid_at: expect.any(Number),
          expired_at: expect.any(Number),
        },
        {
          id: "f-v2",
          project_id: null,
          resource_id: null,
          thread_id: expectedDerivedV2,
          status: "archived",
          invalid_at: expect.any(Number),
          expired_at: expect.any(Number),
        },
        {
          id: "f1",
          project_id: null,
          resource_id: null,
          thread_id: expectedDerivedLegacy,
          status: "archived",
          invalid_at: expect.any(Number),
          expired_at: expect.any(Number),
        },
      ]);
      expect(
        after
          .prepare(
            "SELECT COUNT(*) AS n FROM memory_facts WHERE owner_id = 'acct' AND status = 'archived' AND invalid_at = expired_at",
          )
          .get(),
      ).toEqual({ n: 4 });
      expect(
        after.prepare("SELECT id, scope_id, status, error FROM memory_jobs ORDER BY id").all(),
      ).toEqual([
        {
          id: "j-corrupt",
          scope_id: JSON.stringify({
            accountId: MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
            threadId: quarantinedMalformedJobThreadId("j-corrupt"),
          }),
          status: "failed",
          error: "malformed legacy memory job scope quarantined during v40 migration",
        },
        {
          id: "j-corrupt-done",
          scope_id: JSON.stringify({
            accountId: MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
            threadId: quarantinedMalformedJobThreadId("j-corrupt-done"),
          }),
          status: "done",
          error: "legacy error",
        },
        {
          id: "j-other",
          scope_id: '{"accountId":"other","threadId":"acct:thread-one"}',
          status: "pending",
          error: null,
        },
        {
          id: "j-reflector",
          scope_id: JSON.stringify({ accountId: "acct", threadId: expectedBroad }),
          status: "failed",
          error: "legacy thread scope quarantined during v40 migration",
        },
        {
          id: "j-shape",
          scope_id: JSON.stringify({
            accountId: MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
            threadId: quarantinedMalformedJobThreadId("j-shape"),
          }),
          status: "failed",
          error: "malformed legacy memory job scope quarantined during v40 migration",
        },
        {
          id: "j-target",
          scope_id: JSON.stringify({ accountId: "acct", threadId: expectedLegacy }),
          status: "failed",
          error: "legacy thread scope quarantined during v40 migration",
        },
        {
          id: "j1",
          scope_id: JSON.stringify({ accountId: "acct", threadId: expectedLegacy }),
          status: "failed",
          error: "legacy thread scope quarantined during v40 migration",
        },
        {
          id: "j2",
          scope_id: JSON.stringify({ accountId: "acct", threadId: expectedNull }),
          status: "done",
          error: null,
        },
      ]);
      expect(() =>
        after
          .prepare(
            "SELECT COUNT(*) AS n FROM memory_jobs WHERE json_extract(scope_id, '$.accountId') = ?",
          )
          .get("acct"),
      ).not.toThrow();
      expect(after.pragma("foreign_key_check")).toEqual([]);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v40 rolls back the whole migration when a quarantine target already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v40-memory-thread-collision-"));
    const path = join(dir, "helm.db");
    const legacyId = "acct:thread";
    const targetId = quarantinedParentThreadId("acct", legacyId);
    try {
      const seed = new Database(path);
      seed.pragma("foreign_keys = ON");
      seed.exec(`
        CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE memory_threads (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          resource_id TEXT,
          owner_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE memory_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES memory_threads(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      seed
        .prepare(
          "INSERT INTO memory_threads (id, project_id, owner_id, created_at, updated_at) VALUES (?, ?, 'acct', 1, 1)",
        )
        .run(legacyId, "legacy-project");
      seed
        .prepare(
          "INSERT INTO memory_threads (id, project_id, owner_id, created_at, updated_at) VALUES (?, ?, 'acct', 1, 1)",
        )
        .run(targetId, "collision-project");
      seed
        .prepare(
          "INSERT INTO memory_messages (id, thread_id, role, content, token_estimate, created_at) VALUES ('m1', ?, 'user', 'body', 1, 1)",
        )
        .run(legacyId);
      const record = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, 1000)");
      for (let version = 1; version <= 39; version++) record.run(version);
      seed.close();

      expect(() => runMigrations(path)).toThrow(/quarantine target already exists/);

      const after = new Database(path);
      after.pragma("foreign_keys = ON");
      expect(after.prepare("SELECT version FROM _migrations WHERE version = 40").get()).toBe(
        undefined,
      );
      expect(
        after.prepare("SELECT id, project_id FROM memory_threads ORDER BY project_id").all(),
      ).toEqual([
        { id: targetId, project_id: "collision-project" },
        { id: legacyId, project_id: "legacy-project" },
      ]);
      expect(after.prepare("SELECT thread_id FROM memory_messages WHERE id = 'm1'").get()).toEqual({
        thread_id: legacyId,
      });
      expect(after.pragma("foreign_key_check")).toEqual([]);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v32 backfills telemetry latency and creates admin aggregate indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v32-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      seed.exec(`
        CREATE TABLE telemetry (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          api_key_id TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          final_status TEXT,
          cost_usd REAL,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          cached_tokens INTEGER,
          cache_creation_tokens INTEGER,
          served_model TEXT,
          generation_ms INTEGER,
          created_at INTEGER NOT NULL
        );
      `);
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      for (let v = 1; v <= 31; v++) rec.run(v, Date.now());
      seed
        .prepare(
          `INSERT INTO telemetry (
            id, request_id, api_key_id, decision_json, final_status, cost_usd,
            prompt_tokens, completion_tokens, cached_tokens, cache_creation_tokens,
            served_model, generation_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "t1",
          "req_1",
          "k1",
          JSON.stringify({ latency_total_ms: 1234 }),
          "ok",
          0.01,
          10,
          2,
          1,
          0,
          "gpt-4o",
          500,
          1000,
        );
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      const row = after
        .prepare("SELECT latency_total_ms FROM telemetry WHERE request_id = ?")
        .get("req_1") as { latency_total_ms: number };
      expect(row.latency_total_ms).toBe(1234);
      const telemetryIndexes = after
        .prepare("PRAGMA index_list(telemetry)")
        .all()
        .map((idx) => (idx as { name: string }).name);
      expect(telemetryIndexes).toContain("idx_telemetry_admin_window_cover");
      expect(telemetryIndexes).toContain("idx_telemetry_admin_key_window_cover");
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v37 adds model_search for admin request keyword filtering", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v37-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      seed.exec(`
        CREATE TABLE telemetry (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          api_key_id TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          final_status TEXT,
          cost_usd REAL,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          cached_tokens INTEGER,
          cache_creation_tokens INTEGER,
          served_model TEXT,
          generation_ms INTEGER,
          latency_total_ms INTEGER,
          created_at INTEGER NOT NULL
        );
      `);
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      for (let v = 1; v <= 36; v++) rec.run(v, Date.now());
      seed
        .prepare(
          `INSERT INTO telemetry (
            id, request_id, api_key_id, decision_json, final_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "t1",
          "req_1",
          "k1",
          JSON.stringify({
            requested_model: "Claude-Fable-5",
            final: { model_alias: "anthropic/claude-fable-5" },
            lane: { selected_lane: "premium" },
          }),
          "ok",
          1000,
        );
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      const cols = after
        .prepare("PRAGMA table_xinfo(telemetry)")
        .all()
        .map((c) => (c as { name: string }).name);
      expect(cols).toContain("model_search");
      const row = after
        .prepare("SELECT model_search FROM telemetry WHERE request_id = ?")
        .get("req_1") as { model_search: string };
      expect(row.model_search).toContain("claude-fable-5");
      expect(row.model_search).toContain("premium");
      const telemetryIndexes = after
        .prepare("PRAGMA index_list(telemetry)")
        .all()
        .map((idx) => (idx as { name: string }).name);
      expect(telemetryIndexes).toContain("idx_telemetry_admin_model_window");
      expect(telemetryIndexes).toContain("idx_telemetry_admin_key_model_window");
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v6 rebuild relaxes cost_usd to REAL and preserves existing rows", () => {
    // Simulate an OLD database already migrated through v5 (INTEGER cost_usd)
    // carrying a telemetry row, then let runMigrations apply only v6.
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v6-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      // The seed marks versions 1-5 as applied, so the v1 api_keys table must
      // exist for the honest "old DB" simulation — later migrations (e.g. v8's
      // ALTER TABLE api_keys) depend on it.
      seed.exec(
        `CREATE TABLE api_keys (
          key_id TEXT PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL,
          account_id TEXT NOT NULL,
          role TEXT NOT NULL,
          max_lane TEXT,
          allowed_lanes TEXT,
          allow_custom_model INTEGER NOT NULL DEFAULT 0,
          disabled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );`,
      );
      seed.exec(
        `CREATE TABLE telemetry (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          api_key_id TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          final_status TEXT,
          cost_usd INTEGER,
          created_at INTEGER NOT NULL
        );`,
      );
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      // This fixture seeds only api_keys + telemetry (the tables v6 rewrites);
      // the v18 forgetting deltas target memory_observations/reflections, absent
      // from this minimal fixture, so v18 is pre-marked applied to keep the test
      // scoped to v6's cost_usd rebuild.
      // v20 alters memory_threads (absent from this fixture) → pre-mark applied.
      // v21 dedups memory_messages (absent: v2 marked applied without the CREATE)
      // → pre-mark applied.
      // v28 alters memory_facts (absent from this fixture) → pre-mark applied.
      for (const v of [1, 2, 3, 4, 5, 18, 20, 21, 28]) rec.run(v, Date.now());
      seed
        .prepare(
          "INSERT INTO telemetry (id, request_id, api_key_id, decision_json, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("t1", "req_old", "k1", "{}", 0.00321, Date.now());
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      const type = (
        after.prepare("PRAGMA table_info(telemetry)").all() as Array<{
          name: string;
          type: string;
        }>
      ).find((c) => c.name === "cost_usd")?.type;
      expect(type).toBe("REAL");
      const row = after.prepare("SELECT cost_usd FROM telemetry WHERE id = ?").get("t1") as {
        cost_usd: number;
      };
      expect(row.cost_usd).toBeCloseTo(0.00321, 5);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v10 drops api_keys.max_lane on an existing DB while preserving the row", () => {
    // Simulate an OLD database already migrated through v9 (api_keys still HAS the
    // retired max_lane column) carrying a key row with a stored ceiling + a
    // whitelist, then let runMigrations apply v10 (the DROP COLUMN forward step).
    const dir = mkdtempSync(join(tmpdir(), "helm-sqlite-v10-"));
    const path = join(dir, "helm.db");
    try {
      const seed = new Database(path);
      seed.exec(
        "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
      );
      // v1 shape + the v8 rate-limit columns — api_keys still carries max_lane.
      seed.exec(
        `CREATE TABLE api_keys (
          key_id TEXT PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL,
          account_id TEXT NOT NULL,
          role TEXT NOT NULL,
          max_lane TEXT,
          allowed_lanes TEXT,
          allow_custom_model INTEGER NOT NULL DEFAULT 0,
          disabled INTEGER NOT NULL DEFAULT 0,
          rate_limit_rpm INTEGER,
          rate_limit_tpm INTEGER,
          created_at INTEGER NOT NULL
        );`,
      );
      const rec = seed.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)");
      // This fixture seeds only api_keys; the v18 forgetting deltas target the
      // memory tables (absent here), so v18 is pre-marked applied to keep the
      // test scoped to v10's max_lane DROP COLUMN forward step.
      // v20 alters memory_threads (absent from this fixture) → pre-mark applied.
      // v21 dedups memory_messages (absent here) → pre-mark applied.
      // v22 alters telemetry (absent from this api_keys-only fixture) → pre-mark applied.
      // v24 adds request_payloads.upstream_request_json (table absent from this
      // api_keys-only fixture) → pre-mark applied.
      // v25 (telemetry.generation_ms): no telemetry table here → pre-mark applied.
      // v28 alters memory_facts (absent from this api_keys-only fixture) → pre-mark.
      // v30/v32/v37 alter telemetry (absent here) → pre-mark; v29 (payload_blobs) pre-marked too.
      for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 18, 20, 21, 22, 24, 25, 28, 29, 30, 32, 37])
        rec.run(v, Date.now());
      seed
        .prepare(
          `INSERT INTO api_keys (key_id, hash, prefix, account_id, role, max_lane, allowed_lanes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "k1",
          "h1",
          "helm_live_ab",
          "acct",
          "user",
          "premium",
          '["economy","balanced"]',
          Date.now(),
        );
      seed.close();

      runMigrations(path);

      const after = new Database(path);
      const cols = (
        after.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).not.toContain("max_lane");
      // The row (and its whitelist) survives the drop — only the ceiling column goes.
      const row = after.prepare("SELECT * FROM api_keys WHERE key_id = ?").get("k1") as {
        role: string;
        allowed_lanes: string;
      };
      expect(row.role).toBe("user");
      expect(row.allowed_lanes).toBe('["economy","balanced"]');
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares the composite PK on rate_limit_buckets (key_id, dim) — matches pg + onConflict target", () => {
    const cfg = getTableConfig(rateLimitBuckets);
    const pk = cfg.primaryKeys[0];
    expect(pk).toBeDefined();
    expect(pk?.columns.map((c) => c.name)).toEqual(["key_id", "dim"]);
  });

  it("declares the composite PK on routing_signals (task_type, lane) — matches pg", () => {
    const cfg = getTableConfig(routingSignals);
    const pk = cfg.primaryKeys[0];
    expect(pk).toBeDefined();
    expect(pk?.columns.map((c) => c.name)).toEqual(["task_type", "lane"]);
  });

  it("declares cost_usd as REAL (mirrors pg doublePrecision; no float truncation)", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const cols = raw.prepare("PRAGMA table_info(telemetry)").all() as Array<{
      name: string;
      type: string;
    }>;
    const costUsd = cols.find((c) => c.name === "cost_usd");
    expect(costUsd?.type).toBe("REAL");
    raw.close();
  });

  it("has NO plaintext column on api_keys", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const cols = raw
      .prepare("PRAGMA table_info(api_keys)")
      .all()
      .map((c) => (c as { name: string }).name);
    for (const forbidden of ["plaintext", "key", "secret", "token"]) {
      expect(cols).not.toContain(forbidden);
    }
    raw.close();
  });

  it("enforces a unique constraint on hash", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    const insert = raw.prepare(
      "INSERT INTO api_keys (key_id, hash, prefix, account_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("k1", "samehash", "helm_live_a", "acct", "root", Date.now());
    expect(() => insert.run("k2", "samehash", "helm_live_b", "acct", "user", Date.now())).toThrow();
    raw.close();
  });

  it("maps boolean and array dialect types via Drizzle round-trip", () => {
    const db = createSqliteDb(":memory:");
    db.insert(apiKeys)
      .values({
        keyId: "k1",
        hash: "h1",
        prefix: "helm_live_a",
        accountId: "acct",
        role: "root",
        allowedLanes: JSON.stringify(["balanced", "economy"]),
        allowCustomModel: true,
        disabled: true,
        createdAt: new Date(),
      })
      .run();
    const row = db.select().from(apiKeys).where(eq(apiKeys.keyId, "k1")).get();
    expect(row?.disabled).toBe(true);
    expect(row?.allowCustomModel).toBe(true);
    expect(JSON.parse(row?.allowedLanes ?? "[]")).toEqual(["balanced", "economy"]);
    db.$sqlite.close();
  });

  it("defaults disabled to false when not provided", () => {
    const db = createSqliteDb(":memory:");
    const raw = db.$sqlite;
    raw
      .prepare(
        "INSERT INTO api_keys (key_id, hash, prefix, account_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("k1", "h1", "helm_live_a", "acct", "root", Date.now());
    const row = db.select().from(apiKeys).where(eq(apiKeys.keyId, "k1")).get();
    expect(row?.disabled).toBe(false);
    expect(row?.allowCustomModel).toBe(false);
    raw.close();
  });
});
