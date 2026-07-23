import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as storeExports from "../index.js";
import type { PgDb } from "./migrate.js";
import { createPgDb, createPgliteDb, runPgMigrations } from "./migrate.js";

interface LeaseStore {
  tryAcquire(input: {
    keyId: string;
    leaseId: string;
    ownerId: string;
    limit: number;
    ttlMs: number;
  }): Promise<{ acquired: boolean; expiresAtMs: number }>;
  renew(input: {
    keyId: string;
    leaseId: string;
    ownerId: string;
    ttlMs: number;
  }): Promise<{ renewed: boolean; expiresAtMs: number }>;
  release(input: { keyId: string; leaseId: string; ownerId: string }): Promise<void>;
}

type LeaseStoreConstructor = new (db: PgDb) => LeaseStore;

function leaseStore(db: PgDb): LeaseStore {
  const adapter = Reflect.get(storeExports, "PgConcurrencyLeaseStore");
  expect(adapter, "Postgres must expose its distributed concurrency lease adapter").toBeTypeOf(
    "function",
  );
  return new (adapter as LeaseStoreConstructor)(db);
}

async function tableNames(db: PgDb): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('api_key_concurrency_state', 'api_key_concurrency_leases')
     ORDER BY table_name
  `);
  const rows = Array.isArray(result)
    ? (result as unknown as Array<{ table_name: string }>)
    : ((result as unknown as { rows?: Array<{ table_name: string }> }).rows ?? []);
  return rows.map((row) => row.table_name);
}

async function close(db: PgDb): Promise<void> {
  await db.$close();
}

// Canonical e2e input wins; keep the original local-test variable compatible.
const realPostgresUrl = process.env.PG_TEST_URL ?? process.env.HELM_TEST_POSTGRES_URL;
const realPostgresIt = realPostgresUrl ? it : it.skip;

describe("PgConcurrencyLeaseStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs both lease tables through a repeatable additive migration", async () => {
    const db = await createPgliteDb();
    try {
      expect(await tableNames(db)).toEqual([
        "api_key_concurrency_leases",
        "api_key_concurrency_state",
      ]);
      await runPgMigrations(db);
      expect(await tableNames(db)).toEqual([
        "api_key_concurrency_leases",
        "api_key_concurrency_state",
      ]);
    } finally {
      await close(db);
    }
  });

  it("atomically admits no more than limit concurrent leases", async () => {
    const db = await createPgliteDb();
    try {
      const store = leaseStore(db);
      const attempts = await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          store.tryAcquire({
            keyId: "key-one",
            leaseId: `lease-${index}`,
            ownerId: `replica-${index % 2}`,
            limit: 3,
            ttlMs: 30_000,
          }),
        ),
      );
      expect(attempts.filter((attempt) => attempt.acquired)).toHaveLength(3);
    } finally {
      await close(db);
    }
  });

  it("shares one Postgres limit across two replica stores under 100 concurrent attempts", async () => {
    const db = await createPgliteDb();
    try {
      const replicaA = leaseStore(db);
      const replicaB = leaseStore(db);
      let active = 0;
      let maxActive = 0;
      await Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
          const store = index % 2 === 0 ? replicaA : replicaB;
          const leaseId = `replica-lease-${index}`;
          const acquired = await store.tryAcquire({
            keyId: "shared-key",
            leaseId,
            ownerId: index % 2 === 0 ? "replica-a" : "replica-b",
            limit: 1,
            ttlMs: 30_000,
          });
          if (!acquired.acquired) return;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          await store.release({
            keyId: "shared-key",
            leaseId,
            ownerId: index % 2 === 0 ? "replica-a" : "replica-b",
          });
        }),
      );
      expect(maxActive).toBe(1);
    } finally {
      await close(db);
    }
  });

  it("uses database time rather than the replica's Node clock", async () => {
    const db = await createPgliteDb();
    try {
      const store = leaseStore(db);
      vi.spyOn(Date, "now").mockReturnValue(1);

      const acquired = await store.tryAcquire({
        keyId: "clock-key",
        leaseId: "clock-lease",
        ownerId: "clock-skewed-replica",
        limit: 1,
        ttlMs: 30_000,
      });

      expect(acquired.acquired).toBe(true);
      expect(acquired.expiresAtMs).toBeGreaterThan(25_000);
    } finally {
      await close(db);
    }
  });

  it("returns a database-derived future expiry for the statement-clock SQL path", async () => {
    const db = await createPgliteDb();
    try {
      const store = leaseStore(db);
      const acquired = await store.tryAcquire({
        keyId: "statement-clock-key",
        leaseId: "statement-clock-lease",
        ownerId: "replica-a",
        limit: 1,
        ttlMs: 100,
      });
      expect(acquired.expiresAtMs).toBeGreaterThan(Date.now() + 50);
    } finally {
      await close(db);
    }
  });

  realPostgresIt(
    "bases expiry on statement time after waiting for a row lock across two pools",
    async () => {
      const dbA = await createPgDb(realPostgresUrl as string);
      const dbB = await createPgDb(realPostgresUrl as string);
      const keyId = `clock-lock-${crypto.randomUUID()}`;
      try {
        const lockHeld = dbA.transaction(async (tx) => {
          await tx.execute(sql`
            INSERT INTO api_key_concurrency_state (key_id) VALUES (${keyId})
            ON CONFLICT (key_id) DO NOTHING
          `);
          await tx.execute(sql`
            SELECT key_id FROM api_key_concurrency_state
            WHERE key_id = ${keyId} FOR UPDATE
          `);
          await new Promise((resolve) => setTimeout(resolve, 150));
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        const startedAt = Date.now();
        const attempt = leaseStore(dbB).tryAcquire({
          keyId,
          leaseId: "delayed-lease",
          ownerId: "replica-b",
          limit: 1,
          ttlMs: 200,
        });
        await lockHeld;
        const acquired = await attempt;

        expect(acquired.acquired).toBe(true);
        expect(acquired.expiresAtMs).toBeGreaterThanOrEqual(startedAt + 300);
      } finally {
        await dbA.execute(sql`DELETE FROM api_key_concurrency_leases WHERE key_id = ${keyId}`);
        await dbA.execute(sql`DELETE FROM api_key_concurrency_state WHERE key_id = ${keyId}`);
        await Promise.all([close(dbA), close(dbB)]);
      }
    },
    30_000,
  );

  it("reclaims an expired lease before counting active holders", async () => {
    const db = await createPgliteDb();
    try {
      const store = leaseStore(db);
      expect(
        (
          await store.tryAcquire({
            keyId: "reclaim-key",
            leaseId: "dead-lease",
            ownerId: "dead-replica",
            limit: 1,
            ttlMs: 1,
          })
        ).acquired,
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(
        (
          await store.tryAcquire({
            keyId: "reclaim-key",
            leaseId: "replacement-lease",
            ownerId: "live-replica",
            limit: 1,
            ttlMs: 30_000,
          })
        ).acquired,
      ).toBe(true);
    } finally {
      await close(db);
    }
  });

  it("honors a lowered limit without revoking existing holders and isolates keys", async () => {
    const db = await createPgliteDb();
    try {
      const store = leaseStore(db);
      for (const leaseId of ["a", "b", "c"]) {
        expect(
          (
            await store.tryAcquire({
              keyId: "lowered-key",
              leaseId,
              ownerId: "replica-a",
              limit: 3,
              ttlMs: 30_000,
            })
          ).acquired,
        ).toBe(true);
      }

      expect(
        (
          await store.tryAcquire({
            keyId: "lowered-key",
            leaseId: "blocked",
            ownerId: "replica-b",
            limit: 1,
            ttlMs: 30_000,
          })
        ).acquired,
      ).toBe(false);
      expect(
        (
          await store.tryAcquire({
            keyId: "independent-key",
            leaseId: "independent",
            ownerId: "replica-b",
            limit: 1,
            ttlMs: 30_000,
          })
        ).acquired,
      ).toBe(true);
    } finally {
      await close(db);
    }
  });

  it("fences renew and release by key, lease, and owner", async () => {
    const db = await createPgliteDb();
    try {
      const store = leaseStore(db);
      await store.tryAcquire({
        keyId: "fenced-key",
        leaseId: "owned-lease",
        ownerId: "owner-a",
        limit: 1,
        ttlMs: 30_000,
      });

      expect(
        (
          await store.renew({
            keyId: "fenced-key",
            leaseId: "owned-lease",
            ownerId: "owner-b",
            ttlMs: 30_000,
          })
        ).renewed,
      ).toBe(false);
      await store.release({
        keyId: "fenced-key",
        leaseId: "owned-lease",
        ownerId: "owner-b",
      });
      expect(
        (
          await store.tryAcquire({
            keyId: "fenced-key",
            leaseId: "still-blocked",
            ownerId: "owner-b",
            limit: 1,
            ttlMs: 30_000,
          })
        ).acquired,
      ).toBe(false);
    } finally {
      await close(db);
    }
  });
});
