import { sql } from "drizzle-orm";
import type { ConcurrencyLeaseStore } from "../ports.js";
import type { PgDb } from "./migrate.js";

interface TimestampRow {
  expires_at_ms: number | string;
}

function epochMs(row: TimestampRow | undefined): number {
  return Number(row?.expires_at_ms ?? 0);
}

// Cluster-wide lease adapter. All expiry comparisons and timestamps execute in
// PostgreSQL; no replica wall clock participates in correctness decisions.
export class PgConcurrencyLeaseStore implements ConcurrencyLeaseStore {
  constructor(private readonly db: PgDb) {}

  async tryAcquire(input: {
    keyId: string;
    leaseId: string;
    ownerId: string;
    limit: number;
    ttlMs: number;
  }): Promise<{ acquired: boolean; expiresAtMs: number }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO api_key_concurrency_state (key_id) VALUES (${input.keyId})
        ON CONFLICT (key_id) DO NOTHING
      `);
      await tx.execute(sql`
        SELECT key_id FROM api_key_concurrency_state
        WHERE key_id = ${input.keyId} FOR UPDATE
      `);
      await tx.execute(sql`
        DELETE FROM api_key_concurrency_leases
        WHERE key_id = ${input.keyId} AND expires_at <= clock_timestamp()
      `);
      const active = await tx.execute(sql`
        SELECT count(*)::integer AS count
        FROM api_key_concurrency_leases
        WHERE key_id = ${input.keyId} AND expires_at > clock_timestamp()
      `);
      const rows = resultRows<{ count: number | string }>(active);
      if (Number(rows[0]?.count ?? 0) >= input.limit) {
        const now = await tx.execute(
          sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS expires_at_ms`,
        );
        return { acquired: false, expiresAtMs: epochMs(resultRows<TimestampRow>(now)[0]) };
      }
      const inserted = await tx.execute(sql`
        INSERT INTO api_key_concurrency_leases (lease_id, key_id, owner_id, expires_at)
        VALUES (${input.leaseId}, ${input.keyId}, ${input.ownerId}, clock_timestamp() + (${input.ttlMs} * interval '1 millisecond'))
        RETURNING (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms
      `);
      return { acquired: true, expiresAtMs: epochMs(resultRows<TimestampRow>(inserted)[0]) };
    });
  }

  async renew(input: {
    keyId: string;
    leaseId: string;
    ownerId: string;
    ttlMs: number;
  }): Promise<{ renewed: boolean; expiresAtMs: number }> {
    const result = await this.db.execute(sql`
      UPDATE api_key_concurrency_leases
         SET heartbeat_at = clock_timestamp(),
             expires_at = clock_timestamp() + (${input.ttlMs} * interval '1 millisecond')
       WHERE key_id = ${input.keyId}
         AND lease_id = ${input.leaseId}
         AND owner_id = ${input.ownerId}
         AND expires_at > clock_timestamp()
      RETURNING (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms
    `);
    const row = resultRows<TimestampRow>(result)[0];
    return { renewed: row !== undefined, expiresAtMs: epochMs(row) };
  }

  async release(input: { keyId: string; leaseId: string; ownerId: string }): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM api_key_concurrency_leases
      WHERE key_id = ${input.keyId}
        AND lease_id = ${input.leaseId}
        AND owner_id = ${input.ownerId}
    `);
  }
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] };
  return Array.isArray(maybe.rows) ? maybe.rows : [];
}
