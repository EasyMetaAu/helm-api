import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { createPgliteDb, runPgMigrations } from "./migrate.js";

// A statement-recording RawExecutor stand-in. `failOn` makes one matching
// statement throw, simulating a mid-migration failure so we can assert the
// per-migration transaction rolls back (no half-applied ledger).
function recorder(failOn?: (stmt: string) => boolean) {
  const stmts: string[] = [];
  const execute = async (query: ReturnType<typeof sql.raw>): Promise<unknown> => {
    // drizzle's sql.raw wraps the raw string in queryChunks[0].value (string[]).
    const chunks = (query as unknown as { queryChunks: Array<{ value: string[] }> }).queryChunks;
    const text = (chunks[0]?.value ?? []).join("");
    stmts.push(text);
    if (text.startsWith("SELECT version")) return [];
    if (failOn?.(text)) throw new Error(`boom: ${text}`);
    return [];
  };
  return { stmts, execute };
}

describe("runPgMigrations — per-migration atomicity", () => {
  it("wraps the whole runner in a pg advisory lock", async () => {
    const rec = recorder();
    await runPgMigrations(rec);

    const lock = rec.stmts.indexOf("SELECT pg_advisory_lock(1212501069, 1095780608)");
    const createLedger = rec.stmts.findIndex((s) =>
      s.startsWith("CREATE TABLE IF NOT EXISTS _migrations"),
    );
    const selectLedger = rec.stmts.indexOf("SELECT version FROM _migrations");
    const firstBegin = rec.stmts.indexOf("BEGIN");
    const lastCommit = rec.stmts.lastIndexOf("COMMIT");
    const unlock = rec.stmts.lastIndexOf("SELECT pg_advisory_unlock(1212501069, 1095780608)");

    expect(lock).toBe(0);
    expect(lock).toBeLessThan(createLedger);
    expect(createLedger).toBeLessThan(selectLedger);
    expect(selectLedger).toBeLessThan(firstBegin);
    expect(lastCommit).toBeLessThan(unlock);
    expect(unlock).toBe(rec.stmts.length - 1);
  });

  it("wraps each migration's statements + ledger INSERT in a transaction", async () => {
    const rec = recorder();
    await runPgMigrations(rec);
    // Every migration block must open with BEGIN and close with COMMIT, and the
    // ledger INSERT for that version must fall BETWEEN them.
    const begins = rec.stmts.filter((s) => s === "BEGIN").length;
    const commits = rec.stmts.filter((s) => s === "COMMIT").length;
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBe(commits);
    const firstBegin = rec.stmts.indexOf("BEGIN");
    const firstInsert = rec.stmts.findIndex((s) => s.startsWith("INSERT INTO _migrations"));
    const firstCommit = rec.stmts.indexOf("COMMIT");
    expect(firstBegin).toBeLessThan(firstInsert);
    expect(firstInsert).toBeLessThan(firstCommit);
  });

  it("rolls back and never records the ledger row when a statement fails", async () => {
    // Fail on the first CREATE TABLE of migration v1.
    const rec = recorder((s) => s.startsWith("CREATE TABLE IF NOT EXISTS api_keys"));
    await expect(runPgMigrations(rec)).rejects.toThrow(/boom/);
    expect(rec.stmts).toContain("ROLLBACK");
    expect(rec.stmts.indexOf("ROLLBACK")).toBeLessThan(
      rec.stmts.lastIndexOf("SELECT pg_advisory_unlock(1212501069, 1095780608)"),
    );
    expect(rec.stmts.at(-1)).toBe("SELECT pg_advisory_unlock(1212501069, 1095780608)");
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
    // v29/v31 alter telemetry (absent here) → pre-mark applied; v30 alters api_keys
    // (absent here). v28 (payload_blobs CREATE) is pre-marked too (out of scope).
    // biome-ignore format: keep the version ledger on one readable line
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31]) {
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
    // v28 (payload_blobs), v29/v31 (telemetry generated/aggregate columns), and
    // v30 (api_keys allow_fast_mode) are out of scope here too.
    for (const version of [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27,
      28, 29, 30, 31,
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
