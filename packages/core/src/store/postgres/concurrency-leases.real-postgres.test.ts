import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { PgConcurrencyLeaseStore } from "./concurrency-leases.js";
import { createPgDb, type PgDb, runPgMigrations } from "./migrate.js";

const postgresUrl: string =
  process.env.PG_TEST_URL ??
  process.env.HELM_TEST_POSTGRES_URL ??
  (() => {
    throw new Error(
      "real PostgreSQL lease tests require PG_TEST_URL or HELM_TEST_POSTGRES_URL; run through apps/gateway/e2e/run-with-postgres.sh",
    );
  })();

const openDbs: PgDb[] = [];
afterEach(async () => {
  await Promise.all(openDbs.splice(0).map((db) => db.$close()));
});

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

async function db(): Promise<PgDb> {
  const connection = await createPgDb(postgresUrl);
  openDbs.push(connection);
  return connection;
}

describe("real PostgreSQL concurrency lease contract", () => {
  it("bases expiry on statement time after waiting for a row lock across two pools", async () => {
    const dbA = await db();
    const dbB = await db();
    const store = new PgConcurrencyLeaseStore(dbB);
    const keyId = `real-clock-${crypto.randomUUID()}`;
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let locked!: () => void;
    const lockedReady = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const blocker = dbA.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO api_key_concurrency_state (key_id)
        VALUES (${keyId})
        ON CONFLICT (key_id) DO NOTHING
      `);
      await tx.execute(sql`
        SELECT key_id FROM api_key_concurrency_state
        WHERE key_id = ${keyId}
        FOR UPDATE
      `);
      locked();
      await lockHeld;
    });

    try {
      await lockedReady;
      const startedAt = Date.now();
      const acquire = store.tryAcquire({
        keyId,
        leaseId: `lease-${crypto.randomUUID()}`,
        ownerId: "real-pool-b",
        limit: 1,
        ttlMs: 180,
      });
      await new Promise((resolve) => setTimeout(resolve, 260));
      releaseLock();
      await blocker;
      const acquired = await acquire;
      expect(acquired.acquired).toBe(true);
      expect(acquired.expiresAtMs - startedAt).toBeGreaterThanOrEqual(350);
    } finally {
      releaseLock();
      await blocker.catch(() => {});
      await dbA.execute(sql`DELETE FROM api_key_concurrency_leases WHERE key_id = ${keyId}`);
      await dbA.execute(sql`DELETE FROM api_key_concurrency_state WHERE key_id = ${keyId}`);
    }
  });

  it("migrates an old v40 seed to v41 without losing api key telemetry rate or budget data", async () => {
    const connection = await db();
    const suffix = crypto.randomUUID();
    const keyId = `old-key-${suffix}`;
    const requestId = `old-request-${suffix}`;
    const rateKey = `old-rate-${suffix}`;
    const budgetKey = `old-budget-${suffix}`;

    await connection.execute(sql`
      INSERT INTO api_keys (key_id, hash, prefix, account_id, role, created_at)
      VALUES (${keyId}, 'old-hash', 'old-prefix', 'default', 'user', 1)
    `);
    await connection.execute(sql`
      INSERT INTO telemetry (id, request_id, api_key_id, decision_json, created_at)
      VALUES (${`telemetry-${suffix}`}, ${requestId}, ${keyId}, '{"status":"success"}', 4)
    `);
    await connection.execute(sql`
      INSERT INTO rate_limit_buckets (key_id, dim, tokens, last_refill_ms)
      VALUES (${rateKey}, 'rpm', 7, 8)
    `);
    await connection.execute(sql`
      INSERT INTO usage_budget_buckets (key_id, dim, tokens, last_refill_ms)
      VALUES (${budgetKey}, 'usd', 9, 10)
    `);
    await connection.execute(sql`DROP TABLE api_key_concurrency_leases`);
    await connection.execute(sql`DROP TABLE api_key_concurrency_state`);
    await connection.execute(sql`DELETE FROM _migrations WHERE version = 41`);

    await runPgMigrations(connection);

    const key = await connection.execute(
      sql`SELECT key_id, hash, prefix FROM api_keys WHERE key_id = ${keyId}`,
    );
    const telemetry = await connection.execute(
      sql`SELECT request_id, decision_json FROM telemetry WHERE request_id = ${requestId}`,
    );
    const rate = await connection.execute(
      sql`SELECT key_id, tokens FROM rate_limit_buckets WHERE key_id = ${rateKey}`,
    );
    const budget = await connection.execute(
      sql`SELECT key_id, tokens FROM usage_budget_buckets WHERE key_id = ${budgetKey}`,
    );
    expect(rowsOf(key)).toHaveLength(1);
    expect(rowsOf(telemetry)).toHaveLength(1);
    expect(rowsOf(rate)).toHaveLength(1);
    expect(rowsOf(budget)).toHaveLength(1);

    await connection.execute(sql`DELETE FROM telemetry WHERE request_id = ${requestId}`);
    await connection.execute(sql`DELETE FROM api_keys WHERE key_id = ${keyId}`);
    await connection.execute(sql`DELETE FROM rate_limit_buckets WHERE key_id = ${rateKey}`);
    await connection.execute(sql`DELETE FROM usage_budget_buckets WHERE key_id = ${budgetKey}`);
  });
});
