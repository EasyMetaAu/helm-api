import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import {
  createMaintenanceActivityGate,
  createSerializedMaintenanceQueue,
  createTrackedBackgroundTasks,
  maintenanceActivityMiddleware,
  maintenanceDrainTimeoutMs,
  withPausedActivities,
} from "./maintenance-gate.js";

describe("maintenance drain timeout", () => {
  it("uses the configured request window up to a bounded maintenance ceiling", () => {
    expect(maintenanceDrainTimeoutMs(60_000)).toBe(60_000);
    expect(maintenanceDrainTimeoutMs(900_000)).toBe(120_000);
  });
});

describe("serialized maintenance queue", () => {
  it("keeps scheduled cleanup and vacuum atomic ahead of a manual request", async () => {
    const queue = createSerializedMaintenanceQueue();
    const calls: string[] = [];
    let finishCleanup = () => {};
    const cleanupWaiting = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const scheduled = queue.run(async () => {
      calls.push("scheduled:cleanup");
      await cleanupWaiting;
      calls.push("scheduled:vacuum");
    });
    const manual = queue.run(async () => {
      calls.push("manual:vacuum");
    });

    await Promise.resolve();
    expect(calls).toEqual(["scheduled:cleanup"]);
    finishCleanup();
    await Promise.all([scheduled, manual]);
    expect(calls).toEqual(["scheduled:cleanup", "scheduled:vacuum", "manual:vacuum"]);
  });

  it("closes after active maintenance and rejects later work", async () => {
    const queue = createSerializedMaintenanceQueue();
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = queue.run(() => waiting);
    const closing = queue.closeAndWait();

    await expect(queue.run(async () => {})).rejects.toThrow(
      "database maintenance is shutting down",
    );
    finish();
    await Promise.all([active, closing]);
  });

  it("bounds queued maintenance while an earlier run is stalled", async () => {
    const queue = createSerializedMaintenanceQueue({ maxDepth: 2 });
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = queue.run(() => waiting);
    const queued = queue.run(async () => {});

    await expect(queue.run(async () => {})).rejects.toThrow("database maintenance queue is full");
    finish();
    await Promise.all([active, queued]);
  });
});

describe("maintenance activity gate", () => {
  it("atomically pauses only when no request is active", () => {
    const gate = createMaintenanceActivityGate();
    const active = gate.enter();
    if (!active.ok) throw new Error("expected active request");

    expect(gate.tryPauseIfIdle()).toBe(false);
    gate.release(active.activity);
    expect(gate.tryPauseIfIdle()).toBe(true);
    expect(gate.enter()).toEqual({ ok: false });
    gate.resume();
    expect(gate.enter().ok).toBe(true);
  });

  it("keeps an outer HTTP idle claim through the complete vacuum", async () => {
    const gate = createMaintenanceActivityGate();
    const background = createTrackedBackgroundTasks();
    let finish!: () => void;
    const vacuuming = new Promise<void>((resolve) => {
      finish = resolve;
    });
    expect(gate.tryPauseIfIdle()).toBe(true);

    const vacuum = withPausedActivities([background], async () => vacuuming);
    expect(gate.enter()).toEqual({ ok: false });
    finish();
    await vacuum;
    expect(gate.enter()).toEqual({ ok: false });

    gate.resume();
    const entered = gate.enter();
    expect(entered.ok).toBe(true);
    if (entered.ok) gate.release(entered.activity);
  });

  it.each([
    [
      "OpenAI Responses",
      "/v1/responses",
      {
        error: {
          message: "database maintenance in progress",
          type: "api_error",
          code: "database_maintenance",
          trace_id: "trace-maintenance",
        },
      },
    ],
    [
      "OpenAI Chat",
      "/v1/chat/completions",
      {
        error: {
          message: "database maintenance in progress",
          type: "api_error",
          code: "database_maintenance",
          trace_id: "trace-maintenance",
        },
      },
    ],
    [
      "Responses WebSocket preflight",
      "/v1/models",
      {
        error: {
          message: "database maintenance in progress",
          type: "api_error",
          code: "database_maintenance",
          trace_id: "trace-maintenance",
        },
      },
    ],
    [
      "Anthropic",
      "/v1/messages",
      {
        type: "error",
        error: { type: "overloaded_error", message: "database maintenance in progress" },
      },
    ],
    [
      "Gemini",
      "/v1beta/models/gemini:generateContent",
      {
        error: {
          code: 503,
          message: "database maintenance in progress",
          status: "UNAVAILABLE",
        },
      },
    ],
    [
      "Gemini interactions",
      "/v1beta/interactions",
      {
        error: {
          code: 503,
          message: "database maintenance in progress",
          status: "UNAVAILABLE",
        },
      },
    ],
    [
      "Admin",
      "/admin/api/stats",
      {
        error: {
          code: "database_maintenance",
          message: "database maintenance in progress",
          trace_id: "trace-maintenance",
        },
      },
    ],
  ])("returns a protocol-shaped maintenance 503 for %s", async (_name, path, expected) => {
    const gate = createMaintenanceActivityGate();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("trace_id", "trace-maintenance");
      await next();
    });
    app.use("*", maintenanceActivityMiddleware(gate));
    app.all("*", (c) => c.text("work"));

    await gate.pauseAndWait();
    const response = await app.request(path, { method: "POST" });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual(expected);
  });

  it("rejects new work while paused but keeps health and version available", async () => {
    const gate = createMaintenanceActivityGate();
    const app = new Hono<AppEnv>();
    app.use("*", maintenanceActivityMiddleware(gate));
    app.get("/healthz", (c) => c.text("ok"));
    app.get("/version", (c) => c.text("v"));
    app.get("/work", (c) => c.text("work"));

    await gate.pauseAndWait();
    expect((await app.request("/work")).status).toBe(503);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/version")).status).toBe(200);
    gate.resume();
    expect((await app.request("/work")).status).toBe(200);
  });

  it("waits until an active streaming response body is drained", async () => {
    const gate = createMaintenanceActivityGate();
    const app = new Hono<AppEnv>();
    app.use("*", maintenanceActivityMiddleware(gate));
    let finish = () => {};
    app.get(
      "/stream",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("one"));
              finish = () => controller.close();
            },
          }),
        ),
    );

    const response = await app.request("/stream");
    let paused = false;
    const waiting = gate.pauseAndWait().then(() => {
      paused = true;
    });
    await Promise.resolve();
    expect(paused).toBe(false);
    finish();
    expect(await response.text()).toBe("one");
    await waiting;
    expect(paused).toBe(true);
  });

  it("does not deadlock the admitted request that starts maintenance", async () => {
    const gate = createMaintenanceActivityGate();
    const app = new Hono<AppEnv>();
    app.use("*", maintenanceActivityMiddleware(gate));
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    app.post("/vacuum", async (c) => {
      gate.releaseCurrent();
      markStarted();
      await finished;
      return c.text("done");
    });

    const pendingResponse = app.request("/vacuum", { method: "POST" });
    await started;
    await gate.pauseAndWait();
    gate.resume();
    finish();
    const response = await pendingResponse;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");
  });

  it("resumes paused activities in reverse order when maintenance fails", async () => {
    const calls: string[] = [];
    const activity = (name: string) => ({
      async pauseAndWait() {
        calls.push(`pause:${name}`);
      },
      resume() {
        calls.push(`resume:${name}`);
      },
    });

    await expect(
      withPausedActivities([activity("http"), activity("worker"), activity("writes")], async () => {
        calls.push("vacuum");
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(calls).toEqual([
      "pause:http",
      "pause:worker",
      "pause:writes",
      "vacuum",
      "resume:writes",
      "resume:worker",
      "resume:http",
    ]);
  });

  it("abandons maintenance and resumes already-paused activities when draining times out", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const waiting = new Promise<void>(() => {});
      const maintenance = withPausedActivities(
        [
          {
            async pauseAndWait() {
              calls.push("pause:http");
            },
            resume() {
              calls.push("resume:http");
            },
          },
          {
            async pauseAndWait() {
              calls.push("pause:leaked-task");
              await waiting;
            },
            resume() {
              calls.push("resume:leaked-task");
            },
          },
        ],
        async () => {
          calls.push("vacuum");
        },
        { pauseTimeoutMs: 60_000 },
      );

      const rejection = expect(maintenance).rejects.toThrow("maintenance drain timed out");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
      expect(calls).toEqual([
        "pause:http",
        "pause:leaked-task",
        "resume:leaked-task",
        "resume:http",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for detached store work after the HTTP response has drained", async () => {
    const http = createMaintenanceActivityGate();
    const background = createTrackedBackgroundTasks();
    const app = new Hono<AppEnv>();
    app.use("*", maintenanceActivityMiddleware(http));
    let finishWrite = () => {};
    app.get("/work", (c) => {
      background.run(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          }),
      );
      return c.text("done");
    });

    const response = await app.request("/work");
    expect(await response.text()).toBe("done");
    let vacuumStarted = false;
    const maintenance = withPausedActivities([http, background], async () => {
      vacuumStarted = true;
    });
    await Promise.resolve();
    expect(vacuumStarted).toBe(false);
    finishWrite();
    await maintenance;
    expect(vacuumStarted).toBe(true);
  });

  it("drains non-HTTP producers before pausing detached work", async () => {
    const background = createTrackedBackgroundTasks();
    let finishWrite = () => {};
    const producer = {
      async pauseAndWait() {
        expect(
          background.run(
            () =>
              new Promise<void>((resolve) => {
                finishWrite = resolve;
              }),
          ),
        ).toBe(true);
      },
      resume() {},
    };
    let vacuumStarted = false;
    const maintenance = withPausedActivities([producer, background], async () => {
      vacuumStarted = true;
    });
    await Promise.resolve();
    expect(vacuumStarted).toBe(false);
    finishWrite();
    await maintenance;
    expect(vacuumStarted).toBe(true);
  });

  it("closeAndWait waits for active work and rejects later tasks", async () => {
    const background = createTrackedBackgroundTasks();
    let finish = () => {};
    expect(
      background.run(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    ).toBe(true);
    let closed = false;
    const closing = background.closeAndWait().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(background.run(async () => {})).toBe(false);
    finish();
    await closing;
    expect(closed).toBe(true);
  });

  it("tracks nested work spawned by an active task after pause begins", async () => {
    const background = createTrackedBackgroundTasks();
    let continueParent = () => {};
    const parentReady = new Promise<void>((resolve) => {
      continueParent = resolve;
    });
    let parentStarted = () => {};
    const started = new Promise<void>((resolve) => {
      parentStarted = resolve;
    });
    let finishChild = () => {};
    background.run(async () => {
      parentStarted();
      await parentReady;
      expect(
        background.run(
          () =>
            new Promise<void>((resolve) => {
              finishChild = resolve;
            }),
        ),
      ).toBe(true);
    });

    await started;
    let paused = false;
    const waiting = background.pauseAndWait().then(() => {
      paused = true;
    });
    continueParent();
    await Promise.resolve();
    await Promise.resolve();
    expect(paused).toBe(false);
    finishChild();
    await waiting;
    expect(paused).toBe(true);
  });
});

describe("tracked background tasks", () => {
  it("rejects new detached work once its bounded backlog is full", async () => {
    const tasks = createTrackedBackgroundTasks({ maxTasks: 1 });
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    expect(tasks.run(() => waiting)).toBe(true);
    expect(tasks.run(async () => {})).toBe(false);
    finish();
    await tasks.pauseAndWait();
  });
});
