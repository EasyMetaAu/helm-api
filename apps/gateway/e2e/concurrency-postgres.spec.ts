import {
  createDistributedKeyedSemaphore,
  createPgDb,
  type DistributedKeyedSemaphore,
  PgConcurrencyLeaseStore,
  type PgDb,
} from "@helm/core";
import { expect, test } from "@playwright/test";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.js";
import {
  type ConcurrencyGateConfig,
  concurrencyMiddleware,
  createConcurrencyGate,
} from "../src/middleware/concurrency.js";
import { requestSignal } from "../src/middleware/limits.js";

// This is intentionally request-level E2E rather than another PGlite contract test:
// two independent Hono app dependency graphs and two independent postgres-js pools
// represent two replicas while sharing the exact production lease store/manager.
// The e2e launcher guarantees a real PostgreSQL 17 + pgvector URL before Playwright
// starts. Explicit URL precedence is PG_TEST_URL, then HELM_TEST_POSTGRES_URL.
const postgresUrl = process.env.PG_TEST_URL ?? process.env.HELM_TEST_POSTGRES_URL;

const encoder = new TextEncoder();

interface ProviderState {
  active: number;
  maxActive: number;
  calls: number;
  failures: number;
  cooldowns: number;
}

interface Replica {
  app: Hono<AppEnv>;
  db: PgDb;
  manager: DistributedKeyedSemaphore;
  store: PgConcurrencyLeaseStore;
  ownerId: string;
  closeDb: () => Promise<void>;
  shutdown: () => Promise<void>;
}

interface ReplicaOptions {
  name: string;
  state: ProviderState;
  ttlMs?: number;
  heartbeatMs?: number;
  waitTimeoutMs?: number;
  minQueueSize?: number;
}

function requirePostgresUrl(): string {
  if (!postgresUrl) {
    throw new Error(
      "real PostgreSQL E2E requires PG_TEST_URL or HELM_TEST_POSTGRES_URL; the pnpm test:e2e launcher must provision one",
    );
  }
  return postgresUrl;
}

function providerState(): ProviderState {
  return { active: 0, maxActive: 0, calls: 0, failures: 0, cooldowns: 0 };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createReplica(options: ReplicaOptions): Promise<Replica> {
  const db = await createPgDb(requirePostgresUrl());
  const store = new PgConcurrencyLeaseStore(db);
  const ownerId = `e2e-${options.name}-${crypto.randomUUID()}`;
  let leaseSequence = 0;
  const manager = createDistributedKeyedSemaphore({
    store,
    ownerId,
    leaseTtlMs: options.ttlMs ?? 2_000,
    heartbeatIntervalMs: options.heartbeatMs ?? 500,
    random: () => 0,
    createLeaseId: () => `${ownerId}-lease-${++leaseSequence}`,
  });
  const config: ConcurrencyGateConfig = {
    enabled: true,
    minSize: options.minQueueSize ?? 100,
    multiplier: 0,
    waitTimeoutMs: options.waitTimeoutMs ?? 4_000,
  };
  const gate = createConcurrencyGate({ semaphore: manager, getConfig: () => config });
  const app = createApp({ logger: { log: () => {} } });

  app.use("/work", async (c, next) => {
    const keyId = c.req.header("x-test-key") ?? "real-pg-default";
    const limit = Number(c.req.header("x-test-limit") ?? "1");
    // biome-ignore lint/suspicious/noExplicitAny: request-level test identity seam
    (c as any).set("identity", { keyId, caps: { concurrencyLimit: limit } });
    await next();
  });
  app.use("/work", concurrencyMiddleware(gate));
  app.post("/work", async (c) => {
    options.state.calls += 1;
    options.state.active += 1;
    options.state.maxActive = Math.max(options.state.maxActive, options.state.active);
    try {
      await delay(Number(c.req.header("x-test-work-ms") ?? "2"));
      return c.json({ ok: true });
    } finally {
      options.state.active -= 1;
    }
  });

  let dbClosed = false;
  const closeDb = async (): Promise<void> => {
    if (dbClosed) return;
    dbClosed = true;
    await db.$close();
  };
  return {
    app,
    db,
    manager,
    store,
    ownerId,
    closeDb,
    shutdown: async () => {
      await manager.shutdown();
      await closeDb();
    },
  };
}

async function work(replica: Replica, keyId: string, workMs = 2, limit = 1): Promise<Response> {
  return replica.app.request("/work", {
    method: "POST",
    headers: {
      "x-test-key": keyId,
      "x-test-limit": String(limit),
      "x-test-work-ms": String(workMs),
    },
  });
}

function streamApp(replica: Replica): {
  app: Hono<AppEnv>;
  ready: Promise<void>;
  finish: () => void;
} {
  const ready = deferred();
  const finish = deferred();
  const gate = createConcurrencyGate({
    semaphore: replica.manager,
    getConfig: () => ({ enabled: true, minSize: 10, multiplier: 0, waitTimeoutMs: 4_000 }),
  });
  const app = createApp({ logger: { log: () => {} } });
  app.use("/stream", async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: request-level test identity seam
    (c as any).set("identity", {
      keyId: c.req.header("x-test-key") ?? "stream-key",
      caps: { concurrencyLimit: 1 },
    });
    await next();
  });
  app.use("/stream", concurrencyMiddleware(gate));
  app.get("/stream", (c) => {
    const release = c.get("concurrencyClaim")?.();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: chunk\ndata: first\n\n"));
        ready.resolve();
        void finish.promise.then(async () => {
          controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
          controller.close();
          await release?.();
        });
      },
      async cancel() {
        await release?.();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return { app, ready: ready.promise, finish: finish.resolve };
}

test.describe("real PostgreSQL distributed concurrency leases", () => {
  test("enforces one global slot across two replicas and 100 concurrent requests", async () => {
    test.setTimeout(20_000);
    const state = providerState();
    const replicaA = await createReplica({ name: "load-a", state, waitTimeoutMs: 5_000 });
    const replicaB = await createReplica({ name: "load-b", state, waitTimeoutMs: 5_000 });
    const keyId = `load-${crypto.randomUUID()}`;
    try {
      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          work(index % 2 === 0 ? replicaA : replicaB, keyId, 3),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual(Array(100).fill(200));
      expect(state.calls).toBe(100);
      expect(state.maxActive).toBe(1);
      console.info(`[real-pg] requests=100 max_active=${state.maxActive}`);
    } finally {
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("does not let key A limit=1 block key B", async () => {
    const state = providerState();
    const replicaA = await createReplica({ name: "isolation-a", state });
    const replicaB = await createReplica({ name: "isolation-b", state });
    const holdA = deferred();
    const keyA = `isolation-a-${crypto.randomUUID()}`;
    const keyB = `isolation-b-${crypto.randomUUID()}`;
    try {
      const held = replicaA.manager.acquire({
        key: keyA,
        limit: 1,
        maxQueue: 2,
        timeoutMs: 2_000,
      });
      const leaseA = await held;
      expect(leaseA.ok).toBe(true);

      const responseB = await Promise.race([
        work(replicaB, keyB, 10),
        holdA.promise.then(() => {
          throw new Error("key B waited for unrelated key A");
        }),
      ]);
      expect(responseB.status).toBe(200);
      if (leaseA.ok) await leaseA.release();
    } finally {
      holdA.resolve();
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("recovers capacity after replica crash within TTL plus five seconds", async () => {
    test.setTimeout(10_000);
    const ttlMs = 250;
    const state = providerState();
    const replicaA = await createReplica({
      name: "crash-a",
      state,
      ttlMs,
      heartbeatMs: 1_000,
      waitTimeoutMs: ttlMs + 5_000,
    });
    const replicaB = await createReplica({
      name: "crash-b",
      state,
      ttlMs,
      heartbeatMs: 50,
      waitTimeoutMs: ttlMs + 5_000,
    });
    const keyId = `crash-${crypto.randomUUID()}`;
    try {
      const crashedLease = await replicaA.manager.acquire({
        key: keyId,
        limit: 1,
        maxQueue: 2,
        timeoutMs: 1_000,
      });
      expect(crashedLease.ok).toBe(true);

      const crashedAt = Date.now();
      await replicaA.closeDb();
      const recovered = await replicaB.manager.acquire({
        key: keyId,
        limit: 1,
        maxQueue: 2,
        timeoutMs: ttlMs + 5_000,
      });
      const recoveryMs = Date.now() - crashedAt;
      expect(recovered.ok).toBe(true);
      expect(recoveryMs).toBeLessThanOrEqual(ttlMs + 5_000);
      console.info(`[real-pg] crash_recovery_ms=${recoveryMs} ttl_ms=${ttlMs}`);
      if (recovered.ok) await recovered.release();
    } finally {
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("heartbeats a request beyond two TTLs without oversubscribing", async () => {
    test.setTimeout(10_000);
    const ttlMs = 180;
    const state = providerState();
    const replicaA = await createReplica({
      name: "heartbeat-a",
      state,
      ttlMs,
      heartbeatMs: 40,
      waitTimeoutMs: 4_000,
    });
    const replicaB = await createReplica({
      name: "heartbeat-b",
      state,
      ttlMs,
      heartbeatMs: 40,
      waitTimeoutMs: 4_000,
    });
    const keyId = `heartbeat-${crypto.randomUUID()}`;
    try {
      const first = work(replicaA, keyId, ttlMs * 3);
      await delay(50);
      const second = work(replicaB, keyId, 10);
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(state.maxActive).toBe(1);
    } finally {
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("aborts the unified upstream signal on lease loss without provider cooldown", async () => {
    test.setTimeout(10_000);
    const state = providerState();
    const replica = await createReplica({
      name: "lease-loss-a",
      state,
      ttlMs: 400,
      heartbeatMs: 50,
    });
    const tamperDb = await createPgDb(requirePostgresUrl());
    const tamperStore = new PgConcurrencyLeaseStore(tamperDb);
    const keyId = `lease-loss-${crypto.randomUUID()}`;
    const gate = createConcurrencyGate({
      semaphore: replica.manager,
      getConfig: () => ({ enabled: true, minSize: 2, multiplier: 0, waitTimeoutMs: 2_000 }),
    });
    const app = createApp({ logger: { log: () => {} } });
    app.use("/upstream", async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: request-level test identity seam
      (c as any).set("identity", { keyId, caps: { concurrencyLimit: 1 } });
      await next();
    });
    app.use("/upstream", concurrencyMiddleware(gate));
    const entered = deferred();
    app.get("/upstream", async (c) => {
      state.calls += 1;
      entered.resolve();
      const signal = requestSignal(c);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      if (String(signal.reason).includes("lease_lost")) {
        return c.json({ error: "lease_lost" }, 503);
      }
      state.failures += 1;
      state.cooldowns += 1;
      return c.json({ error: "provider_failure" }, 502);
    });
    try {
      const responsePromise = app.request("/upstream");
      await entered.promise;
      await tamperStore.release({
        keyId,
        leaseId: `${replica.ownerId}-lease-1`,
        ownerId: replica.ownerId,
      });
      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(state.calls).toBe(1);
      expect(state.failures).toBe(0);
      expect(state.cooldowns).toBe(0);
      console.info("[real-pg] lease_loss provider_failures=0 provider_cooldowns=0");
    } finally {
      await tamperDb.$close();
      await replica.shutdown();
    }
  });

  test("holds a streaming slot until the final event and reader cancel", async () => {
    test.setTimeout(10_000);
    const state = providerState();
    const replicaA = await createReplica({ name: "stream-a", state, waitTimeoutMs: 4_000 });
    const replicaB = await createReplica({ name: "stream-b", state, waitTimeoutMs: 4_000 });
    const keyId = `stream-${crypto.randomUUID()}`;
    try {
      const first = streamApp(replicaA);
      const response = await first.app.request("/stream", { headers: { "x-test-key": keyId } });
      await first.ready;
      const competing = work(replicaB, keyId, 5);
      let competingDone = false;
      void competing.then(() => {
        competingDone = true;
      });
      await delay(100);
      expect(competingDone).toBe(false);
      first.finish();
      expect(await response.text()).toContain("[DONE]");
      expect((await competing).status).toBe(200);

      const cancelled = streamApp(replicaA);
      const cancelResponse = await cancelled.app.request("/stream", {
        headers: { "x-test-key": keyId },
      });
      await cancelled.ready;
      const reader = cancelResponse.body?.getReader();
      expect(reader).toBeTruthy();
      await reader?.read();
      const blocked = work(replicaB, keyId, 5);
      await delay(100);
      await reader?.cancel("client_cancelled");
      expect((await blocked).status).toBe(200);
    } finally {
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("fails closed with protocol 503 and zero provider calls when the DB is unavailable", async () => {
    const state = providerState();
    const replica = await createReplica({ name: "db-down", state });
    try {
      await replica.closeDb();
      const response = await work(replica, `db-down-${crypto.randomUUID()}`);
      expect(response.status).toBe(503);
      expect(state.calls).toBe(0);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("lane_unavailable");
    } finally {
      await replica.shutdown();
    }
  });
});
