import { createKeyedSemaphore } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  type ConcurrencyGateConfig,
  concurrencyMiddleware,
  createConcurrencyGate,
} from "./concurrency.js";

// Per-key concurrency overflow queue (issue #93, feature A). Real semaphore +
// real timers: the waits in play are tiny (handler-controlled), no fake clock.

function cfg(over: Partial<ConcurrencyGateConfig> = {}): ConcurrencyGateConfig {
  return { enabled: true, minSize: 5, multiplier: 0, waitTimeoutMs: 10_000, ...over };
}

// Build an app whose handler resolves when WE say so — lets a test hold N
// requests in flight deterministically.
function buildApp(config: ConcurrencyGateConfig, limit: number | null) {
  const gate = createConcurrencyGate({
    semaphore: createKeyedSemaphore(),
    getConfig: () => config,
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal identity stub for the test
    (c as any).set("identity", { keyId: "k1", caps: { concurrencyLimit: limit } });
    await next();
  });
  app.use("*", concurrencyMiddleware(gate));
  let releaseHandler: (() => void) | null = null;
  const handlerGate = () =>
    new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
  app.get("/held", async (c) => {
    await handlerGate();
    return c.json({ ok: true });
  });
  app.get("/fast", (c) => c.json({ ok: true }));
  return { app, finishHeld: () => releaseHandler?.() };
}

describe("createConcurrencyGate", () => {
  it("no-ops when disabled or the key has no limit", async () => {
    const semaphore = createKeyedSemaphore();
    const disabled = createConcurrencyGate({ semaphore, getConfig: () => cfg({ enabled: false }) });
    const r1 = await disabled.acquire({
      keyId: "k",
      limit: 1,
      signal: new AbortController().signal,
    });
    expect(r1.ok).toBe(true);
    const enabled = createConcurrencyGate({ semaphore, getConfig: () => cfg() });
    const r2 = await enabled.acquire({
      keyId: "k",
      limit: null,
      signal: new AbortController().signal,
    });
    expect(r2.ok).toBe(true);
    expect(semaphore.inFlight("k")).toBe(0); // nothing was tracked
  });

  it("computes maxQueue = MAX(floor(multiplier × limit), minSize); 0 ⇒ minSize only", async () => {
    const semaphore = createKeyedSemaphore();
    // multiplier 2 × limit 2 = 4 > minSize 1 ⇒ queue of 4: 2 run, 4 wait, 7th rejected
    const gate = createConcurrencyGate({
      semaphore,
      getConfig: () => cfg({ minSize: 1, multiplier: 2, waitTimeoutMs: 10_000 }),
    });
    const signal = new AbortController().signal;
    const leases = [
      await gate.acquire({ keyId: "k", limit: 2, signal }),
      await gate.acquire({ keyId: "k", limit: 2, signal }),
    ];
    const queued = Array.from({ length: 4 }, () => gate.acquire({ keyId: "k", limit: 2, signal }));
    await Promise.resolve(); // let the waiters enqueue
    const overflow = await gate.acquire({ keyId: "k", limit: 2, signal });
    expect(overflow).toMatchObject({ ok: false, reason: "queue_full", retryAfterSeconds: 1 });
    for (const l of leases) if (l.ok) l.release();
    for (const q of queued) {
      const r = await q;
      expect(r.ok).toBe(true);
      if (r.ok) r.release();
    }
  });

  it("times out a queued waiter with retry-after 5", async () => {
    const gate = createConcurrencyGate({
      semaphore: createKeyedSemaphore(),
      getConfig: () => cfg({ waitTimeoutMs: 30 }),
    });
    const signal = new AbortController().signal;
    const lease = await gate.acquire({ keyId: "k", limit: 1, signal });
    const blocked = await gate.acquire({ keyId: "k", limit: 1, signal });
    expect(blocked).toMatchObject({ ok: false, reason: "timeout", retryAfterSeconds: 5 });
    if (lease.ok) lease.release();
  });
});

describe("concurrencyMiddleware", () => {
  it("passes through when the key has no concurrency limit", async () => {
    const { app } = buildApp(cfg(), null);
    expect((await app.request("/fast")).status).toBe(200);
  });

  it("queues the 2nd request and serves it when the 1st finishes", async () => {
    const { app, finishHeld } = buildApp(cfg({ minSize: 5 }), 1);
    const first = app.request("/held");
    await new Promise((r) => setTimeout(r, 20)); // 1st is in the handler, slot held
    const second = Promise.resolve(app.request("/fast")); // queued behind it
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(secondDone).toBe(false); // still waiting on the slot
    finishHeld();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("returns 429 with retry-after when the queue is full", async () => {
    const { app, finishHeld } = buildApp(cfg({ minSize: 1 }), 1);
    const first = app.request("/held"); // holds the slot
    await new Promise((r) => setTimeout(r, 20));
    const queued = app.request("/fast"); // fills the queue (size 1)
    await new Promise((r) => setTimeout(r, 20));
    const rejected = await app.request("/fast"); // overflow
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    const body = (await rejected.json()) as { error: { type: string; limited_by: string } };
    expect(body.error.type).toBe("rate_limited");
    expect(body.error.limited_by).toBe("concurrency");
    finishHeld();
    expect((await first).status).toBe(200);
    expect((await queued).status).toBe(200);
  });

  it("returns 429 when the queue wait times out", async () => {
    const { app, finishHeld } = buildApp(cfg({ minSize: 5, waitTimeoutMs: 30 }), 1);
    const first = app.request("/held");
    await new Promise((r) => setTimeout(r, 20));
    const blocked = await app.request("/fast");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("5");
    finishHeld();
    expect((await first).status).toBe(200);
  });

  it("releases the slot after a handler error (next request proceeds)", async () => {
    const gate = createConcurrencyGate({
      semaphore: createKeyedSemaphore(),
      getConfig: () => cfg({ minSize: 1, waitTimeoutMs: 200 }),
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal identity stub for the test
      (c as any).set("identity", { keyId: "k1", caps: { concurrencyLimit: 1 } });
      await next();
    });
    app.use("*", concurrencyMiddleware(gate));
    app.get("/boom", () => {
      throw new Error("handler exploded");
    });
    app.get("/ok", (c) => c.json({ ok: true }));
    app.onError((_err, c) => c.json({ error: "boom" }, 500));
    expect((await app.request("/boom")).status).toBe(500);
    // The slot must have been released by the middleware finally.
    expect((await app.request("/ok")).status).toBe(200);
  });

  it("a claimed lease is NOT released by the middleware (stream handoff)", async () => {
    const semaphore = createKeyedSemaphore();
    const gate = createConcurrencyGate({ semaphore, getConfig: () => cfg({ minSize: 1 }) });
    const app = new Hono();
    app.use("*", async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal identity stub for the test
      (c as any).set("identity", { keyId: "k1", caps: { concurrencyLimit: 1 } });
      await next();
    });
    app.use("*", concurrencyMiddleware(gate));
    let release: (() => void) | undefined;
    app.get("/claim", (c) => {
      release = c.get("concurrencyClaim")?.();
      return c.json({ ok: true });
    });
    expect((await app.request("/claim")).status).toBe(200);
    // Handler returned, but the slot is still held (claimed for the stream).
    expect(semaphore.inFlight("k1")).toBe(1);
    release?.();
    expect(semaphore.inFlight("k1")).toBe(0);
  });
});
