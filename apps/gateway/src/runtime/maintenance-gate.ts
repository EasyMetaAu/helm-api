import { AsyncLocalStorage } from "node:async_hooks";
import {
  anthropicTransformErrorOut,
  geminiTransformErrorOut,
  openaiTransformErrorOut,
} from "@helm/core";
import { makeHelmError } from "@helm/shared";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

type Activity = object;

export function maintenanceDrainTimeoutMs(requestTimeoutMs: number): number {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("requestTimeoutMs must be positive");
  }
  return Math.min(Math.floor(requestTimeoutMs), 120_000);
}

export function createSerializedMaintenanceQueue() {
  let tail: Promise<void> = Promise.resolve();
  let closed = false;

  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("database maintenance is shutting down"));
      const result = tail.then(work, work);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async closeAndWait(): Promise<void> {
      closed = true;
      await tail;
    },
  };
}

export function createMaintenanceActivityGate() {
  const current = new AsyncLocalStorage<Activity>();
  const active = new Set<Activity>();
  const idleWaiters: Array<() => void> = [];
  let paused = false;

  const release = (activity: Activity): void => {
    if (!active.delete(activity) || active.size !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  const releaseCurrent = (): void => {
    const caller = current.getStore();
    if (caller) release(caller);
  };

  return {
    enter(): { ok: true; activity: Activity } | { ok: false } {
      if (paused) return { ok: false };
      const activity = {};
      active.add(activity);
      return { ok: true, activity };
    },
    run<T>(activity: Activity, work: () => T): T {
      return current.run(activity, work);
    },
    release,
    releaseCurrent,
    tryPauseIfIdle(): boolean {
      if (paused || active.size !== 0) return false;
      paused = true;
      return true;
    },
    async pauseAndWait(): Promise<void> {
      paused = true;
      releaseCurrent();
      if (active.size === 0) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    resume(): void {
      paused = false;
    },
  };
}

export type MaintenanceActivityGate = ReturnType<typeof createMaintenanceActivityGate>;

const MAINTENANCE_MESSAGE = "database maintenance in progress";

function maintenanceErrorBody(path: string, traceId: string) {
  const error = makeHelmError({
    error_class: "lane_unavailable",
    message: MAINTENANCE_MESSAGE,
    trace_id: traceId,
  });
  if (path === "/v1/messages" || path.startsWith("/v1/messages/")) {
    return anthropicTransformErrorOut(error).body;
  }
  if (
    path.startsWith("/v1beta/models/") ||
    path.startsWith("/models/") ||
    path === "/v1beta/interactions"
  ) {
    return geminiTransformErrorOut(error).body;
  }
  if (
    path === "/v1/models" ||
    path.startsWith("/v1/") ||
    path === "/responses" ||
    path.startsWith("/responses/") ||
    path.startsWith("/openai/") ||
    path === "/chat/completions" ||
    path.startsWith("/engines/")
  ) {
    const body = openaiTransformErrorOut(error).body;
    return { ...body, error: { ...body.error, code: "database_maintenance" } };
  }
  return {
    error: {
      code: "database_maintenance",
      message: MAINTENANCE_MESSAGE,
      trace_id: traceId,
    },
  };
}

export function createTrackedBackgroundTasks() {
  type TaskToken = object;
  const current = new AsyncLocalStorage<TaskToken>();
  const active = new Map<TaskToken, Promise<void>>();
  let state: "open" | "paused" | "closed" = "open";
  const waitForIdle = async (): Promise<void> => {
    while (active.size > 0) await Promise.all(active.values());
  };

  return {
    run(task: () => Promise<unknown>, onError: (error: unknown) => void = () => {}): boolean {
      const parent = current.getStore();
      if (state !== "open" && (parent === undefined || !active.has(parent))) return false;
      const token = {};
      const promise = Promise.resolve()
        .then(() => current.run(token, task))
        .then(() => undefined)
        .catch((error: unknown) => {
          try {
            onError(error);
          } catch {
            // Logging is advisory; a detached failure must stay fail-open.
          }
        })
        .finally(() => active.delete(token));
      active.set(token, promise);
      return true;
    },
    async pauseAndWait(): Promise<void> {
      if (state === "open") state = "paused";
      await waitForIdle();
    },
    resume(): void {
      if (state === "paused") state = "open";
    },
    async closeAndWait(): Promise<void> {
      state = "closed";
      await waitForIdle();
    },
  };
}

export interface PausableActivity {
  pauseAndWait(): Promise<void>;
  resume(): void;
}

export async function withPausedActivities<T>(
  activities: readonly PausableActivity[],
  work: () => Promise<T>,
  options: { pauseTimeoutMs?: number } = {},
): Promise<T> {
  const paused: PausableActivity[] = [];
  const pauseTimeoutMs = options.pauseTimeoutMs;
  const deadline =
    pauseTimeoutMs !== undefined && Number.isFinite(pauseTimeoutMs) && pauseTimeoutMs > 0
      ? Date.now() + pauseTimeoutMs
      : null;
  try {
    for (const activity of activities) {
      paused.push(activity);
      const draining = activity.pauseAndWait();
      if (deadline === null) {
        await draining;
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("maintenance drain timed out");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          draining,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("maintenance drain timed out")),
              remainingMs,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
    return await work();
  } finally {
    for (const activity of paused.reverse()) activity.resume();
  }
}

function responseWithRelease(response: Response, release: () => void): Response {
  if (response.body === null) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            release();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    }),
    response,
  );
}

export function maintenanceActivityMiddleware(
  gate: MaintenanceActivityGate,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.path === "/healthz" || c.req.path === "/version") return await next();
    const entered = gate.enter();
    if (!entered.ok) {
      c.header("Retry-After", "1");
      return c.json(maintenanceErrorBody(c.req.path, c.get("trace_id") ?? "unknown"), 503);
    }
    let delegated = false;
    try {
      await gate.run(entered.activity, next);
      c.res = responseWithRelease(c.res, () => gate.release(entered.activity));
      delegated = true;
    } finally {
      if (!delegated) gate.release(entered.activity);
    }
  };
}
