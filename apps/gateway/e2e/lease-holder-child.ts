import { createDistributedKeyedSemaphore, createPgDb, PgConcurrencyLeaseStore } from "@helm/core";

const postgresUrl = process.env.PG_TEST_URL ?? process.env.HELM_TEST_POSTGRES_URL;
const keyId = process.env.LEASE_TEST_KEY_ID;
const ttlMs = Number(process.env.LEASE_TEST_TTL_MS ?? "0");
const ownerId = `child-replica-${process.pid}-${crypto.randomUUID()}`;

if (!postgresUrl || !keyId || !Number.isFinite(ttlMs) || ttlMs <= 0) {
  throw new Error("child replica requires PostgreSQL URL, LEASE_TEST_KEY_ID and LEASE_TEST_TTL_MS");
}

const db = await createPgDb(postgresUrl);
const manager = createDistributedKeyedSemaphore({
  store: new PgConcurrencyLeaseStore(db),
  ownerId,
  leaseTtlMs: ttlMs,
  heartbeatIntervalMs: Math.max(25, Math.floor(ttlMs / 3)),
  random: () => 0,
  createLeaseId: () => `${ownerId}-lease`,
});
const held = await manager.acquire({
  key: keyId,
  limit: 1,
  maxQueue: 0,
  timeoutMs: 2_000,
});
if (!held.ok) throw new Error(`child replica failed to acquire lease: ${held.reason}`);

process.stdout.write(`${JSON.stringify({ event: "lease-held", ownerId })}\n`);
setInterval(() => {}, 60_000);
await new Promise<never>(() => {});
