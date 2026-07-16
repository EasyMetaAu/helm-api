import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import {
  MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
  projectScopedThreadId,
  quarantinedMalformedJobThreadId,
  quarantinedParentThreadId,
  quarantinedRawThreadId,
} from "../../memory/thread-scope.js";
import { createPgliteDb, runPgMigrations } from "./migrate.js";

// A statement-recording migration runner. The root execute path is tracked
// separately from the transaction-bound executor so this contract proves that
// pooled migrations never send lock/DDL/ledger statements outside the reserved
// transaction connection. `failOn` simulates a mid-migration failure.
function recorder(failOn?: (stmt: string) => boolean) {
  const stmts: string[] = [];
  let rootCalls = 0;
  const sessionExecute = async (query: ReturnType<typeof sql.raw>): Promise<unknown> => {
    // drizzle's sql.raw wraps the raw string in queryChunks[0].value (string[]).
    const chunks = (query as unknown as { queryChunks: Array<{ value: string[] }> }).queryChunks;
    const text = (chunks[0]?.value ?? []).join("");
    stmts.push(text);
    if (text.startsWith("SELECT version")) return [];
    if (failOn?.(text)) throw new Error(`boom: ${text}`);
    return [];
  };
  const execute = async (query: ReturnType<typeof sql.raw>): Promise<unknown> => {
    rootCalls += 1;
    return sessionExecute(query);
  };
  const transaction = async <T>(
    callback: (tx: { execute: typeof sessionExecute }) => Promise<T>,
  ) => {
    stmts.push("BEGIN");
    try {
      const result = await callback({ execute: sessionExecute });
      stmts.push("COMMIT");
      return result;
    } catch (error) {
      stmts.push("ROLLBACK");
      throw error;
    }
  };
  return {
    stmts,
    execute,
    transaction,
    get rootCalls() {
      return rootCalls;
    },
  };
}

describe("runPgMigrations — per-migration atomicity", () => {
  it("acquires a transaction-scoped advisory lock on the reserved transaction connection", async () => {
    const rec = recorder();
    await runPgMigrations(rec);

    const firstBegin = rec.stmts.indexOf("BEGIN");
    const lock = rec.stmts.indexOf("SELECT pg_advisory_xact_lock(1212501069, 1095780608)");
    const createLedger = rec.stmts.findIndex((s) =>
      s.startsWith("CREATE TABLE IF NOT EXISTS _migrations"),
    );
    const selectLedger = rec.stmts.indexOf("SELECT version FROM _migrations");

    expect(firstBegin).toBe(0);
    expect(firstBegin).toBeLessThan(lock);
    expect(lock).toBeLessThan(createLedger);
    expect(createLedger).toBeLessThan(selectLedger);
    expect(selectLedger).toBeLessThan(rec.stmts.indexOf("COMMIT"));
    expect(rec.stmts).not.toContain("SELECT pg_advisory_unlock(1212501069, 1095780608)");
    expect(rec.rootCalls).toBe(0);
  });

  it("wraps each migration's statements + ledger INSERT in one reserved transaction", async () => {
    const rec = recorder();
    await runPgMigrations(rec);
    // Every migration block must open with BEGIN and close with COMMIT, and the
    // ledger INSERT for that version must fall BETWEEN them.
    const begins = rec.stmts.filter((s) => s === "BEGIN").length;
    const commits = rec.stmts.filter((s) => s === "COMMIT").length;
    const locks = rec.stmts.filter(
      (s) => s === "SELECT pg_advisory_xact_lock(1212501069, 1095780608)",
    ).length;
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBe(commits);
    expect(locks).toBe(begins);
    const firstInsert = rec.stmts.findIndex((s) => s.startsWith("INSERT INTO _migrations"));
    const migrationBegin = rec.stmts.lastIndexOf("BEGIN", firstInsert);
    const migrationCommit = rec.stmts.indexOf("COMMIT", firstInsert);
    const migrationLock = rec.stmts.indexOf(
      "SELECT pg_advisory_xact_lock(1212501069, 1095780608)",
      migrationBegin,
    );
    const ledgerRecheck = rec.stmts.indexOf(
      "SELECT version FROM _migrations WHERE version = 1",
      migrationLock,
    );
    expect(migrationBegin).toBeLessThan(migrationLock);
    expect(migrationLock).toBeLessThan(ledgerRecheck);
    expect(ledgerRecheck).toBeLessThan(firstInsert);
    expect(firstInsert).toBeLessThan(migrationCommit);
  });

  it("rolls back and never records the ledger row when a statement fails", async () => {
    // Fail on the first CREATE TABLE of migration v1.
    const rec = recorder((s) => s.startsWith("CREATE TABLE IF NOT EXISTS api_keys"));
    await expect(runPgMigrations(rec)).rejects.toThrow(/boom/);
    expect(rec.stmts).toContain("ROLLBACK");
    expect(rec.stmts.at(-1)).toBe("ROLLBACK");
    // The version-1 ledger INSERT must NOT have been issued.
    expect(rec.stmts.some((s) => /INSERT INTO _migrations.*VALUES \(1,/.test(s))).toBe(false);
  });

  it("still applies cleanly against a real PGlite database (idempotent)", async () => {
    const db = await createPgliteDb();
    // Re-running is a no-op (ledger already full); must not throw.
    await runPgMigrations(db);
    await db.$close();
  });

  it("v31 backfills telemetry latency and creates admin aggregate indexes", async () => {
    const client = new PGlite();
    const db = Object.assign(drizzlePglite(client), { $close: () => client.close() });
    await db.execute(
      sql.raw("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE telemetry (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          api_key_id TEXT NOT NULL,
          decision_json JSONB NOT NULL,
          final_status TEXT,
          cost_usd DOUBLE PRECISION,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          cached_tokens INTEGER,
          cache_creation_tokens INTEGER,
          served_model TEXT,
          generation_ms INTEGER,
          created_at BIGINT NOT NULL
        )
      `),
    );
    for (let version = 1; version <= 30; version++) {
      await db.execute(
        sql.raw(`INSERT INTO _migrations (version, applied_at) VALUES (${version}, 1000)`),
      );
    }
    await db.execute(
      sql.raw(`
        INSERT INTO telemetry (
          id, request_id, api_key_id, decision_json, final_status, cost_usd,
          prompt_tokens, completion_tokens, cached_tokens, cache_creation_tokens,
          served_model, generation_ms, created_at
        ) VALUES (
          't1', 'req_1', 'k1', '{"latency_total_ms":1234}'::jsonb, 'ok', 0.01,
          10, 2, 1, 0, 'gpt-4o', 500, 1000
        )
      `),
    );

    await expect(runPgMigrations(db)).resolves.toBeUndefined();

    const row = (await db.execute(
      sql.raw("SELECT latency_total_ms FROM telemetry WHERE request_id = 'req_1'"),
    )) as { rows: Array<{ latency_total_ms: number }> };
    expect(row.rows[0]?.latency_total_ms).toBe(1234);
    const indexes = (await db.execute(
      sql.raw("SELECT indexname FROM pg_indexes WHERE tablename = 'telemetry'"),
    )) as { rows: Array<{ indexname: string }> };
    expect(indexes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        "idx_telemetry_admin_window_cover",
        "idx_telemetry_admin_key_window_cover",
      ]),
    );
    await db.$close();
  });

  it("v36 adds model_search for admin request keyword filtering", async () => {
    const client = new PGlite();
    const db = Object.assign(drizzlePglite(client), { $close: () => client.close() });
    await db.execute(
      sql.raw("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE telemetry (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          api_key_id TEXT NOT NULL,
          decision_json JSONB NOT NULL,
          final_status TEXT,
          cost_usd DOUBLE PRECISION,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          cached_tokens INTEGER,
          cache_creation_tokens INTEGER,
          served_model TEXT,
          generation_ms INTEGER,
          latency_total_ms INTEGER,
          created_at BIGINT NOT NULL
        )
      `),
    );
    for (let version = 1; version <= 35; version++) {
      await db.execute(
        sql.raw(`INSERT INTO _migrations (version, applied_at) VALUES (${version}, 1000)`),
      );
    }
    await db.execute(
      sql.raw(`
        INSERT INTO telemetry (
          id, request_id, api_key_id, decision_json, final_status, created_at
        ) VALUES (
          't1',
          'req_1',
          'k1',
          '{"requested_model":"Claude-Fable-5","final":{"model_alias":"anthropic/claude-fable-5"},"lane":{"selected_lane":"premium"}}'::jsonb,
          'ok',
          1000
        )
      `),
    );

    await expect(runPgMigrations(db)).resolves.toBeUndefined();

    const row = (await db.execute(
      sql.raw("SELECT model_search FROM telemetry WHERE request_id = 'req_1'"),
    )) as { rows: Array<{ model_search: string }> };
    expect(row.rows[0]?.model_search).toContain("claude-fable-5");
    expect(row.rows[0]?.model_search).toContain("premium");
    const indexes = (await db.execute(
      sql.raw("SELECT indexname FROM pg_indexes WHERE tablename = 'telemetry'"),
    )) as { rows: Array<{ indexname: string }> };
    expect(indexes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        "idx_telemetry_admin_model_window",
        "idx_telemetry_admin_key_model_window",
      ]),
    );
    await db.$close();
  });

  it("v37 adds blocked_models for per-key model blacklists", async () => {
    const client = new PGlite();
    const db = Object.assign(drizzlePglite(client), { $close: () => client.close() });
    await db.execute(
      sql.raw("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"),
    );
    await db.execute(sql.raw("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY)"));
    for (let version = 1; version <= 36; version++) {
      await db.execute(
        sql.raw(`INSERT INTO _migrations (version, applied_at) VALUES (${version}, 1000)`),
      );
    }

    await expect(runPgMigrations(db)).resolves.toBeUndefined();

    const columns = (await db.execute(
      sql.raw(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'api_keys'
      `),
    )) as { rows: Array<{ column_name: string }> };
    expect(columns.rows.map((r) => r.column_name)).toContain("blocked_models");
    await db.execute(
      sql.raw("INSERT INTO api_keys (key_id, blocked_models) VALUES ('k1', '[\"gpt-4o\"]'::jsonb)"),
    );
    const row = (await db.execute(
      sql.raw("SELECT blocked_models FROM api_keys WHERE key_id = 'k1'"),
    )) as { rows: Array<{ blocked_models: string[] }> };
    expect(row.rows[0]?.blocked_models).toEqual(["gpt-4o"]);
    await db.$close();
  });

  it("v38 adds and backfills per-thread admin activity summaries", async () => {
    const client = new PGlite();
    const db = Object.assign(drizzlePglite(client), { $close: () => client.close() });
    await db.execute(
      sql.raw("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"),
    );
    await db.execute(
      sql.raw(`
      CREATE TABLE memory_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        resource_id TEXT,
        owner_id TEXT,
        last_served_model TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE TABLE memory_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        created_at BIGINT NOT NULL,
        message_index INTEGER,
        content_hash TEXT
      )
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE TABLE memory_observations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        source_message_range JSONB NOT NULL,
        observation_text TEXT NOT NULL,
        observed_at BIGINT NOT NULL
      )
    `),
    );
    await db.execute(
      sql.raw(`
      INSERT INTO memory_threads (id, owner_id, created_at, updated_at)
      VALUES ('t1', 'a', 100, 100), ('empty', 'a', 100, 100)
    `),
    );
    await db.execute(
      sql.raw(`
      INSERT INTO memory_messages (id, thread_id, role, content, token_estimate, created_at)
      VALUES ('m1', 't1', 'user', 'one', 1, 1000),
             ('m2', 't1', 'assistant', 'two', 1, 2000)
    `),
    );
    await db.execute(
      sql.raw(`
      INSERT INTO memory_observations
        (id, thread_id, source_message_range, observation_text, observed_at)
      VALUES ('o1', 't1', '["m1","m2"]'::jsonb, 'summary', 3000)
    `),
    );
    for (let version = 1; version <= 37; version++) {
      await db.execute(
        sql.raw(`INSERT INTO _migrations (version, applied_at) VALUES (${version}, 1000)`),
      );
    }

    await expect(runPgMigrations(db)).resolves.toBeUndefined();

    const result = (await db.execute(
      sql.raw(`
      SELECT id, message_count, last_message_at, observation_count, last_observation_at
      FROM memory_threads ORDER BY id
    `),
    )) as { rows: Array<Record<string, unknown>> };
    expect(result.rows).toEqual([
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
    await db.$close();
  });

  it("v39 rewrites legacy memory thread ids and every reference atomically", async () => {
    const client = new PGlite();
    const db = Object.assign(drizzlePglite(client), { $close: () => client.close() });
    const existingV2 = projectScopedThreadId("acct", "existing-project", "existing-thread");
    await db.execute(
      sql.raw("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_threads (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          resource_id TEXT,
          owner_id TEXT,
          last_served_model TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          last_message_at BIGINT,
          observation_count INTEGER NOT NULL DEFAULT 0,
          last_observation_at BIGINT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES memory_threads(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL,
          created_at BIGINT NOT NULL,
          message_index INTEGER,
          content_hash TEXT
        )
      `),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_observations (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES memory_threads(id),
          source_message_range JSONB NOT NULL,
          observation_text TEXT NOT NULL,
          observed_at BIGINT NOT NULL
        )
      `),
    );
    await db.execute(
      sql.raw(
        "CREATE TABLE memory_reflections (id TEXT PRIMARY KEY, owner_id TEXT, project_id TEXT, resource_id TEXT, thread_id TEXT, status TEXT NOT NULL DEFAULT 'active', updated_at BIGINT NOT NULL DEFAULT 0)",
      ),
    );
    await db.execute(
      sql.raw(
        "CREATE TABLE memory_facts (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT, resource_id TEXT, thread_id TEXT, status TEXT NOT NULL DEFAULT 'active', invalid_at BIGINT, expired_at BIGINT, updated_at BIGINT NOT NULL DEFAULT 0)",
      ),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO memory_threads
          (id, project_id, resource_id, owner_id, message_count, observation_count, created_at, updated_at)
        VALUES
          ('acct:thread-one', 'project-α', 'legacy-resource', 'acct', 1, 1, 1, 2),
          ('acct:thread-null', NULL, NULL, 'acct', 1, 0, 3, 4),
          ('${existingV2}', 'existing-project', 'existing-resource', 'acct', 0, 0, 5, 6)
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO memory_messages
          (id, thread_id, role, content, token_estimate, created_at)
        VALUES
          ('m1', 'acct:thread-one', 'user', 'one', 1, 10),
          ('m2', 'acct:thread-null', 'user', 'null', 1, 11)
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO memory_observations
          (id, thread_id, source_message_range, observation_text, observed_at)
        VALUES ('o1', 'acct:thread-one', '["m1","m1"]'::jsonb, 'summary', 12)
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO memory_reflections (id, owner_id, project_id, resource_id, thread_id) VALUES
          ('r1', 'acct', 'project-α', 'legacy-resource', 'acct:thread-one'),
          ('r-raw', 'acct', 'project-α', 'manual-resource', 'acct:manual'),
          ('r-v2', 'acct', 'existing-project', 'existing-resource', '${existingV2}'),
          ('r-broad', 'acct', 'project-α', NULL, NULL),
          ('r-other', 'other', 'other-project', NULL, 'acct:thread-one')
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO memory_facts (id, owner_id, project_id, resource_id, thread_id) VALUES
          ('f1', 'acct', 'project-α', 'legacy-resource', 'acct:thread-one'),
          ('f-raw', 'acct', 'project-α', 'manual-resource', 'v2:n:manual'),
          ('f-v2', 'acct', 'existing-project', 'existing-resource', '${existingV2}'),
          ('f-broad', 'acct', 'project-α', NULL, NULL),
          ('f-other', 'other', 'other-project', NULL, 'acct:thread-one')
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at)
        VALUES
          ('j1', 'observer', '{"accountId":"acct","projectId":"project-α","threadId":"acct:thread-one"}', 'pending', 1, 1),
          ('j2', 'observer', '{"accountId":"acct","threadId":"acct:thread-null"}', 'done', 1, 1),
          ('j-target', 'observer', '{"accountId":"acct","threadId":"${quarantinedParentThreadId("acct", "acct:thread-one")}"}', 'pending', 1, 1),
          ('j-reflector', 'reflector', '{"accountId":"acct","projectId":"project-α"}', 'running', 1, 1),
          ('j-corrupt', 'observer', 's1', 'pending', 1, 1),
          ('j-corrupt-done', 'observer', '{bad', 'done', 1, 1),
          ('j-shape', 'observer', '{"accountId":42,"threadId":[]}', 'running', 1, 1),
          ('j-other', 'observer', '{"accountId":"other","threadId":"acct:thread-one"}', 'pending', 1, 1)
      `),
    );
    await db.execute(
      sql.raw(`
        CREATE UNIQUE INDEX uniq_memory_jobs_open_type_scope
          ON memory_jobs (type, scope_id)
          WHERE status IN ('pending', 'running')
      `),
    );
    for (let version = 1; version <= 38; version++) {
      await db.execute(
        sql.raw(`INSERT INTO _migrations (version, applied_at) VALUES (${version}, 1000)`),
      );
    }

    await expect(runPgMigrations(db)).resolves.toBeUndefined();
    await expect(runPgMigrations(db)).resolves.toBeUndefined();

    const expectedLegacy = quarantinedParentThreadId("acct", "acct:thread-one");
    const expectedNull = quarantinedParentThreadId("acct", "acct:thread-null");
    const expectedOpaqueV2 = quarantinedParentThreadId("acct", existingV2);
    const expectedDerivedLegacy = quarantinedRawThreadId("acct", "acct:thread-one");
    const expectedDerivedV2 = quarantinedRawThreadId("acct", existingV2);
    const expectedRaw = quarantinedRawThreadId("acct", "acct:manual");
    const expectedRawV2 = quarantinedRawThreadId("acct", "v2:n:manual");
    const expectedBroad = quarantinedRawThreadId("acct", "");
    const threads = (await db.execute(
      sql.raw("SELECT id, project_id, resource_id FROM memory_threads ORDER BY id"),
    )) as { rows: Array<{ id: string; project_id: string | null; resource_id: string | null }> };
    expect(threads.rows).toEqual(
      [
        { id: expectedOpaqueV2, project_id: null, resource_id: null },
        { id: expectedLegacy, project_id: null, resource_id: null },
        { id: expectedNull, project_id: null, resource_id: null },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const messages = (await db.execute(
      sql.raw("SELECT id, thread_id FROM memory_messages ORDER BY id"),
    )) as { rows: Array<{ id: string; thread_id: string }> };
    expect(messages.rows).toEqual([
      { id: "m1", thread_id: expectedLegacy },
      { id: "m2", thread_id: expectedNull },
    ]);
    const observations = (await db.execute(
      sql.raw("SELECT thread_id FROM memory_observations"),
    )) as { rows: Array<{ thread_id: string }> };
    expect(observations.rows).toEqual([{ thread_id: expectedLegacy }]);
    const reflections = (await db.execute(
      sql.raw(
        "SELECT id, project_id, resource_id, thread_id, status FROM memory_reflections ORDER BY id",
      ),
    )) as {
      rows: Array<{
        id: string;
        project_id: string | null;
        resource_id: string | null;
        thread_id: string;
        status: string;
      }>;
    };
    expect(reflections.rows).toEqual([
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
    const facts = (await db.execute(
      sql.raw(
        "SELECT id, project_id, resource_id, thread_id, status, invalid_at, expired_at FROM memory_facts ORDER BY id",
      ),
    )) as {
      rows: Array<{
        id: string;
        project_id: string | null;
        resource_id: string | null;
        thread_id: string;
        status: string;
        invalid_at: number | null;
        expired_at: number | null;
      }>;
    };
    expect(facts.rows).toEqual([
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
    const invalidatedFacts = (await db.execute(
      sql.raw(
        "SELECT COUNT(*)::integer AS n FROM memory_facts WHERE owner_id = 'acct' AND status = 'archived' AND invalid_at = expired_at",
      ),
    )) as { rows: Array<{ n: number }> };
    expect(invalidatedFacts.rows).toEqual([{ n: 4 }]);
    const jobs = (await db.execute(
      sql.raw("SELECT id, scope_id, status, error FROM memory_jobs ORDER BY id"),
    )) as {
      rows: Array<{
        id: string;
        scope_id: string;
        status: string;
        error: string | null;
      }>;
    };
    expect(jobs.rows).toEqual([
      {
        id: "j-corrupt",
        scope_id: JSON.stringify({
          accountId: MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
          threadId: quarantinedMalformedJobThreadId("j-corrupt"),
        }),
        status: "failed",
        error: "malformed legacy memory job scope quarantined during v39 migration",
      },
      {
        id: "j-corrupt-done",
        scope_id: JSON.stringify({
          accountId: MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
          threadId: quarantinedMalformedJobThreadId("j-corrupt-done"),
        }),
        status: "done",
        error: null,
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
        error: "legacy thread scope quarantined during v39 migration",
      },
      {
        id: "j-shape",
        scope_id: JSON.stringify({
          accountId: MALFORMED_JOB_QUARANTINE_ACCOUNT_ID,
          threadId: quarantinedMalformedJobThreadId("j-shape"),
        }),
        status: "failed",
        error: "malformed legacy memory job scope quarantined during v39 migration",
      },
      {
        id: "j-target",
        scope_id: JSON.stringify({ accountId: "acct", threadId: expectedLegacy }),
        status: "failed",
        error: "legacy thread scope quarantined during v39 migration",
      },
      {
        id: "j1",
        scope_id: JSON.stringify({ accountId: "acct", threadId: expectedLegacy }),
        status: "failed",
        error: "legacy thread scope quarantined during v39 migration",
      },
      {
        id: "j2",
        scope_id: JSON.stringify({ accountId: "acct", threadId: expectedNull }),
        status: "done",
        error: null,
      },
    ]);
    await expect(
      db.execute(
        sql.raw("SELECT COUNT(*) FROM memory_jobs WHERE scope_id::jsonb ->> 'accountId' = 'acct'"),
      ),
    ).resolves.toBeDefined();
    const orphanCount = (await db.execute(
      sql.raw(`
        SELECT COUNT(*)::integer AS n
          FROM memory_messages AS child
          LEFT JOIN memory_threads AS parent ON parent.id = child.thread_id
         WHERE parent.id IS NULL
      `),
    )) as { rows: Array<{ n: number }> };
    expect(orphanCount.rows).toEqual([{ n: 0 }]);
    await db.$close();
  });

  it("v39 rolls back the parent and ledger when a quarantine target already exists", async () => {
    const client = new PGlite();
    const db = Object.assign(drizzlePglite(client), { $close: () => client.close() });
    const legacyId = "acct:thread";
    const targetId = quarantinedParentThreadId("acct", legacyId);
    await db.execute(
      sql.raw("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_threads (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          resource_id TEXT,
          owner_id TEXT,
          last_served_model TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          last_message_at BIGINT,
          observation_count INTEGER NOT NULL DEFAULT 0,
          last_observation_at BIGINT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES memory_threads(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL,
          created_at BIGINT NOT NULL
        )
      `),
    );
    await db.execute(sql`
      INSERT INTO memory_threads (id, project_id, owner_id, created_at, updated_at)
      VALUES (${legacyId}, 'legacy-project', 'acct', 1, 1),
             (${targetId}, 'collision-project', 'acct', 1, 1)
    `);
    await db.execute(sql`
      INSERT INTO memory_messages (id, thread_id, role, content, token_estimate, created_at)
      VALUES ('m1', ${legacyId}, 'user', 'body', 1, 1)
    `);
    for (let version = 1; version <= 38; version++) {
      await db.execute(
        sql.raw(`INSERT INTO _migrations (version, applied_at) VALUES (${version}, 1000)`),
      );
    }

    await expect(runPgMigrations(db)).rejects.toThrow(/quarantine target already exists/);

    const ledger = (await db.execute(
      sql.raw("SELECT version FROM _migrations WHERE version = 39"),
    )) as { rows: Array<{ version: number }> };
    expect(ledger.rows).toEqual([]);
    const parents = (await db.execute(
      sql.raw("SELECT id, project_id FROM memory_threads ORDER BY project_id"),
    )) as { rows: Array<{ id: string; project_id: string }> };
    expect(parents.rows).toEqual([
      { id: targetId, project_id: "collision-project" },
      { id: legacyId, project_id: "legacy-project" },
    ]);
    const child = (await db.execute(
      sql.raw("SELECT thread_id FROM memory_messages WHERE id = 'm1'"),
    )) as { rows: Array<{ thread_id: string }> };
    expect(child.rows).toEqual([{ thread_id: legacyId }]);
    await db.$close();
  });

  it("creates memory job admin-stats indexes", async () => {
    const db = await createPgliteDb();
    const indexes = (await db.execute(
      sql.raw("SELECT indexname FROM pg_indexes WHERE tablename = 'memory_jobs'"),
    )) as { rows: Array<{ indexname: string }> };
    expect(indexes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(["idx_memory_jobs_status_updated_at", "idx_memory_jobs_type_status"]),
    );
    await db.$close();
  });

  // docs/12 "Schema deltas" (P2) — the forgetting migration (sqlite v18 / pg
  // v17). Additive columns + the new account-scoped memory_facts table, mirrored
  // into the pg dialect per CLAUDE.md (dialect differences sealed in the adapter).
  it("adds the forgetting columns + memory_facts (account-scoped) on a fresh db", async () => {
    const db = await createPgliteDb();
    const cols = async (table: string): Promise<string[]> => {
      const res = (await db.execute(
        sql.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`),
      )) as { rows: Array<{ column_name: string }> };
      return res.rows.map((r) => r.column_name);
    };

    expect(await cols("memory_observations")).toEqual(
      expect.arrayContaining([
        "reference_count",
        "importance",
        "status",
        "archived_at",
        "expired_at",
      ]),
    );
    expect(await cols("memory_reflections")).toEqual(
      expect.arrayContaining(["referenced_at", "reference_count", "status"]),
    );
    expect(await cols("memory_facts")).toEqual(
      expect.arrayContaining([
        "id",
        "owner_id",
        "subject_key",
        "fact_text",
        "content_hash",
        "valid_from",
        "invalid_at",
        "expired_at",
        "status",
      ]),
    );

    // Dedup is account-scoped (UNIQUE(owner_id, content_hash)): two accounts may
    // assert the same content_hash; the same account may not (idempotent ingest).
    const hash = "h".repeat(64);
    const ins = (id: string, owner: string) =>
      db.execute(
        sql.raw(
          `INSERT INTO memory_facts (id, owner_id, subject_key, fact_text, content_hash, valid_from, created_at, updated_at)
           VALUES ('${id}', '${owner}', 's', 'fact', '${hash}', 1, 1, 1)`,
        ),
      );
    await expect(ins("f-a", "acct-a")).resolves.toBeDefined();
    await expect(ins("f-b", "acct-b")).resolves.toBeDefined();
    await expect(ins("f-a2", "acct-a")).rejects.toThrow();
    await db.$close();
  });

  it("upgrades a real pre-unique-index memory_jobs table with duplicate open jobs", async () => {
    const client = new PGlite();
    const db = Object.assign(drizzlePglite(client), { $close: () => client.close() });
    const scope = JSON.stringify({ accountId: "acct-a", threadId: "t1" });
    await db.execute(
      sql.raw("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"),
    );
    // Seed everything EXCEPT the memory migrations (v13–v15) as applied, so
    // only they run — the minimal seed has no api_keys table for v9–v12/v16/v18, and
    // no memory_observations table for the v17 forgetting deltas, so both are
    // pre-marked applied to keep this test scoped to the v13–v15 jobs upgrade.
    // v19 (memory_threads.last_served_model) is also pre-marked: this fixture
    // never creates memory_threads, so the v19 ALTER would fail — out of scope.
    // v20 (memory_messages dedup) likewise: this fixture never creates
    // memory_messages, so its dedup DELETE would fail — out of scope here (it has
    // its own dedicated test below).
    // v21 (telemetry token columns): this fixture never creates telemetry, so the
    // ALTER would fail — pre-mark applied, out of scope for this jobs upgrade.
    // v22 (oauth_usage day→bucket_ms rename): this fixture never creates oauth_usage,
    // so the RENAME would fail — pre-marked, out of scope.
    // v23 adds request_payloads.upstream_request_json; this memory_jobs fixture
    // never creates request_payloads → pre-mark applied (out of scope).
    // v24 (telemetry.generation_ms): no telemetry table here → pre-mark applied.
    // v25 adds oauth_quota.usage_limited_until_ms; this fixture never creates
    // oauth_quota → pre-mark applied (out of scope).
    // v27 (pgvector + tsvector over memory_facts): this fixture never creates
    // memory_facts (+ no pgvector here) → pre-mark applied, out of scope.
    // v29/v31/v36 alter telemetry (absent here) → pre-mark applied; v30 alters api_keys
    // (absent here). v28 (payload_blobs CREATE) is pre-marked too (out of scope).
    // biome-ignore format: keep the version ledger on one readable line
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31, 36]) {
      await db.execute(
        sql.raw(`INSERT INTO _migrations (version, applied_at) VALUES (${version}, 1000)`),
      );
    }
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_reflections (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          resource_id TEXT,
          thread_id TEXT,
          reflection_text TEXT NOT NULL,
          version INTEGER NOT NULL,
          token_estimate INTEGER NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_jobs (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES
        ('keep-earliest', 'observer', '${scope}', 'pending', 100, 100),
        ('close-pending', 'observer', '${scope}', 'pending', 200, 200),
        ('close-running', 'observer', '${scope}', 'running', 300, 300)
      `),
    );

    await expect(runPgMigrations(db)).resolves.toBeUndefined();

    const openRows = (await db.execute(
      sql.raw(
        `SELECT id, status FROM memory_jobs WHERE type = 'observer' AND scope_id = '${scope}' AND status IN ('pending','running') ORDER BY created_at, id`,
      ),
    )) as { rows: Array<{ id: string; status: string }> };
    expect(openRows.rows).toEqual([{ id: "keep-earliest", status: "pending" }]);

    const closedRows = (await db.execute(
      sql.raw(
        "SELECT id, status, error FROM memory_jobs WHERE id IN ('close-pending','close-running')",
      ),
    )) as { rows: Array<{ id: string; status: string; error: string }> };
    expect(closedRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "close-pending", status: "failed" }),
        expect.objectContaining({ id: "close-running", status: "failed" }),
      ]),
    );
    expect(closedRows.rows.every((r) => r.error.includes("migration cleanup"))).toBe(true);
    await expect(
      db.execute(
        sql.raw(
          `INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES ('blocked-by-index', 'observer', '${scope}', 'pending', 400, 400)`,
        ),
      ),
    ).rejects.toThrow();
    await db.execute(sql.raw("UPDATE memory_jobs SET status = 'done' WHERE id = 'keep-earliest'"));
    await expect(
      db.execute(
        sql.raw(
          `INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES ('new-open-after-done', 'observer', '${scope}', 'pending', 500, 500)`,
        ),
      ),
    ).resolves.toBeDefined();
    await db.$close();
  });

  it("upgrades a real pre-v20 memory_messages table: preserves repeated turns + adds the unique index", async () => {
    const client = new PGlite();
    const db = Object.assign(drizzlePglite(client), { $close: () => client.close() });
    await db.execute(
      sql.raw("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"),
    );
    // Mark everything EXCEPT v20 applied so only the dedup migration runs. This
    // fixture only creates memory_messages, so other migrations' tables are absent
    // — pre-marking keeps the test scoped to the v20 message-dedup upgrade.
    // v21 (telemetry token columns) is pre-marked too: no telemetry table here, so
    // its ALTER would fail — keep the test scoped to v20. v22 (oauth_usage rename)
    // likewise: no oauth_usage table here, so its RENAME would fail — pre-marked.
    // v23 adds request_payloads.upstream_request_json (table absent here) → pre-mark.
    // v24 (telemetry.generation_ms): no telemetry table here → pre-mark applied.
    // v25 adds oauth_quota.usage_limited_until_ms (oauth_quota absent here) → pre-mark.
    // v26 (idx_memory_jobs_claim): no memory_jobs table in this messages fixture → pre-mark.
    // v27 (pgvector + tsvector over memory_facts): this messages fixture never creates
    // memory_facts (+ no pgvector here) → pre-mark applied, out of scope.
    // v28 (payload_blobs), v29/v31/v36 (telemetry generated/aggregate columns), and
    // v30 (api_keys allow_fast_mode) are out of scope here too.
    for (const version of [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27,
      28, 29, 30, 31, 36,
    ]) {
      await db.execute(
        sql.raw(`INSERT INTO _migrations (version, applied_at) VALUES (${version}, 1000)`),
      );
    }
    await db.execute(
      sql.raw(`
        CREATE TABLE memory_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          token_estimate INTEGER NOT NULL,
          created_at BIGINT NOT NULL
        )
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO memory_messages (id, thread_id, role, content, token_estimate, created_at) VALUES
        ('first', 't1', 'user', 'dup', 1, 100),
        ('second', 't1', 'user', 'dup', 1, 200),
        ('third', 't1', 'user', 'dup', 1, 300),
        ('other', 't1', 'assistant', 'unique', 1, 150)
      `),
    );

    await expect(runPgMigrations(db)).resolves.toBeUndefined();

    // Legacy rows lack occurrence keys, so repeated content must be preserved.
    // The migration cannot safely distinguish duplicate ingest from a user who
    // genuinely repeated the same message at different transcript positions.
    const rows = (await db.execute(sql.raw("SELECT id FROM memory_messages ORDER BY id"))) as {
      rows: Array<{ id: string }>;
    };
    expect(rows.rows.map((r) => r.id)).toEqual(["first", "other", "second", "third"]);

    // The UNIQUE index rejects a duplicate (thread_id, message_index, role, content_hash).
    await db.execute(
      sql.raw(
        "INSERT INTO memory_messages (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash) VALUES ('h1', 't2', 0, 'user', 'x', 1, 1, 'hash-x')",
      ),
    );
    await expect(
      db.execute(
        sql.raw(
          "INSERT INTO memory_messages (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash) VALUES ('h2', 't2', 0, 'user', 'x', 1, 2, 'hash-x')",
        ),
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql.raw(
          "INSERT INTO memory_messages (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash) VALUES ('h3', 't2', 1, 'user', 'x', 1, 3, 'hash-x')",
        ),
      ),
    ).resolves.toBeDefined();
    await db.$close();
  });
});
