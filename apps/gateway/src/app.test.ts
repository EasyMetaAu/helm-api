import { type ErrorClass, makeHelmError } from "@helm/shared";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "./app.js";
import { createApp } from "./app.js";
import type { LogFields, Logger, LogLevel } from "./logging.js";
import { HelmHttpError, handleError, openAIErrorEnvelope } from "./middleware/error-handler.js";
import { requestTimedOut } from "./middleware/limits.js";
import { RequestAdmissionError } from "./runtime/memory-admission.js";

interface Captured {
  level: LogLevel;
  message: string;
  fields: LogFields;
}

function fakeLogger() {
  const lines: Captured[] = [];
  const logger: Logger = {
    log: (level, message, fields = {}) => lines.push({ level, message, fields }),
  };
  return { logger, lines };
}

// Minimal Hono Context stub for calling handleError directly (the SSE paths do this).
function mockCtx(logger: Logger, traceId: string): Context<AppEnv> {
  const store: Record<string, unknown> = { trace_id: traceId, logger };
  return {
    get: (k: string) => store[k],
    header: () => {},
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    body: (b: string | null, status?: number) => new Response(b, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>;
}

describe("createApp: trace_id, logging, error handling", () => {
  it("generates a trace_id when none is provided", async () => {
    const { logger, lines } = fakeLogger();
    const app = createApp({ logger });
    app.get("/ping", (c) => c.text("ok"));
    const res = await app.request("/ping");
    const header = res.headers.get("X-Trace-Id");
    expect(header).toBeTruthy();
    const completed = lines.find((l) => l.message === "request.completed");
    expect(completed?.fields.trace_id).toBe(header);
  });

  it("propagates an incoming X-Request-Id", async () => {
    const { logger, lines } = fakeLogger();
    const app = createApp({ logger, genTraceId: () => "server-request-123" });
    app.get("/ping", (c) => c.json({ trace: c.get("trace_id") }));
    const res = await app.request("/ping", { headers: { "X-Request-Id": "abc-123" } });
    expect(res.headers.get("X-Trace-Id")).toBe("abc-123");
    expect(res.headers.get("X-Helm-Request-Id")).toBe("server-request-123");
    const body = (await res.json()) as { trace: string };
    expect(body.trace).toBe("abc-123");
    const completed = lines.find((l) => l.message === "request.completed");
    expect(completed?.fields.trace_id).toBe("abc-123");
    expect(completed?.fields.request_id).toBe("server-request-123");
  });

  it("emits one structured completion log with required fields", async () => {
    const { logger, lines } = fakeLogger();
    const app = createApp({ logger });
    app.get("/ping", (c) => c.text("ok"));
    await app.request("/ping");
    const completed = lines.filter((l) => l.message === "request.completed");
    expect(completed).toHaveLength(1);
    const f = completed[0]?.fields ?? {};
    expect(f).toMatchObject({ method: "GET", path: "/ping", status: 200 });
    expect(typeof f.request_id).toBe("string");
    expect(typeof f.trace_id).toBe("string");
    expect(typeof f.duration_ms).toBe("number");
  });

  it("serializes a thrown HelmError to an OpenAI-shaped body", async () => {
    const { logger, lines } = fakeLogger();
    const app = createApp({ logger, genTraceId: () => "trace-xyz" });
    app.get("/boom", () => {
      throw new HelmHttpError(
        makeHelmError({ error_class: "timeout", message: "took too long", trace_id: "trace-xyz" }),
      );
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("timeout");
    expect(body.error.type).toBe("api_error");
    expect(body.error.trace_id).toBe("trace-xyz");
    expect(lines.find((line) => line.message === "request.error")?.fields.fault_scope).toBe(
      "request",
    );
  });

  it.each<[ErrorClass, number, string, string]>([
    ["auth_error", 401, "invalid_request_error", "invalid_api_key"],
    ["invalid_request", 400, "invalid_request_error", "invalid_request"],
    ["lane_unavailable", 503, "api_error", "lane_unavailable"],
    ["all_providers_failed", 502, "api_error", "all_providers_failed"],
    ["capability_unsatisfiable", 422, "invalid_request_error", "capability_unsatisfiable"],
    ["upstream_error", 502, "api_error", "upstream_error"],
    ["timeout", 504, "api_error", "timeout"],
    ["rate_limited", 429, "rate_limit_error", "rate_limited"],
  ])("maps %s -> %i %s/%s", async (errorClass, status, type, code) => {
    const { logger } = fakeLogger();
    const app = createApp({ logger });
    app.get("/e", (c) => {
      throw new HelmHttpError(
        makeHelmError({ error_class: errorClass, message: "x", trace_id: c.get("trace_id") }),
      );
    });
    const res = await app.request("/e");
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.type).toBe(type);
    expect(body.error.code).toBe(code);
  });

  it("falls back unknown errors to upstream_error(502) without leaking detail", async () => {
    const { logger, lines } = fakeLogger();
    const app = createApp({ logger });
    app.get("/raw", () => {
      throw new Error("boom-internal-detail");
    });
    const res = await app.request("/raw");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("boom-internal-detail");
    const body = JSON.parse(text) as { error: Record<string, string> };
    expect(body.error.code).toBe("upstream_error");
    expect(lines.find((line) => line.message === "request.error")).toMatchObject({
      level: "error",
      fields: { fault_scope: "gateway_internal" },
    });
  });

  it("logs maintenance admission without stale capacity fields or request payload data", async () => {
    const { logger, lines } = fakeLogger();
    const c = mockCtx(logger, "trace-memory");
    const res = handleError(
      new RequestAdmissionError(503, "database_maintenance", "database maintenance in progress", {
        cause: "paused",
        wireBytes: 12,
        requestedChargeBytes: 72,
        activeReservedBytes: 144,
        pendingBytes: 24,
      }),
      c,
    );

    expect(res.status).toBe(503);
    expect(
      lines.find((line) => line.message === "request.maintenance_rejected")?.fields,
    ).toMatchObject({
      trace_id: "trace-memory",
      admission_reason: "paused",
      wire_bytes: 12,
      requested_charge_bytes: 72,
      active_reserved_bytes: 144,
      pending_bytes: 24,
    });
    expect(JSON.stringify(lines)).not.toContain("active_capacity_bytes");
    expect(JSON.stringify(lines)).not.toContain("heap_used_bytes");
    expect(JSON.stringify(lines)).not.toContain("payload");
  });

  it("logs capacity rejection separately from database maintenance", async () => {
    const { logger, lines } = fakeLogger();
    const c = mockCtx(logger, "trace-capacity");
    const res = handleError(
      new RequestAdmissionError(503, "server_overloaded", "capacity exhausted", {
        cause: "capacity",
        wireBytes: 12,
        requestedChargeBytes: 72,
        activeReservedBytes: 144,
        pendingBytes: 24,
      }),
      c,
    );

    expect(res.status).toBe(503);
    expect(lines.find((line) => line.message === "request.capacity_rejected")).toBeDefined();
    expect(lines.find((line) => line.message === "request.maintenance_rejected")).toBeUndefined();
  });

  it("marks the request context as timed out while late route work continues", async () => {
    const { logger } = fakeLogger();
    const app = createApp({
      logger,
      limits: { requestTimeoutMs: 5 },
      genTraceId: () => "trace-timeout",
    });
    let lateTimedOut: boolean | null = null;
    let lateDone: (() => void) | null = null;
    const late = new Promise<void>((resolve) => {
      lateDone = resolve;
    });
    app.get("/slow", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      lateTimedOut = requestTimedOut(c);
      lateDone?.();
      return c.text("late");
    });

    const res = await app.request("/slow");
    expect(res.status).toBe(504);
    await late;
    expect(lateTimedOut).toBe(true);
  });

  it("does not leak Authorization header into logs or error bodies", async () => {
    const { logger, lines } = fakeLogger();
    const app = createApp({ logger });
    app.get("/boom", () => {
      throw new Error("fail");
    });
    const res = await app.request("/boom", {
      headers: { Authorization: "Bearer helm_live_PLAINTEXT" },
    });
    const text = await res.text();
    expect(text).not.toContain("helm_live_PLAINTEXT");
    expect(JSON.stringify(lines)).not.toContain("helm_live_PLAINTEXT");
  });

  it("treats a client disconnect (aborted) as 499, not a 5xx provider fault", async () => {
    const { logger, lines } = fakeLogger();
    const app = createApp({ logger });
    app.get("/abort", () => {
      // An abort surfaces as an Error whose message includes "aborted" (docs/02).
      throw new Error("The operation was aborted");
    });
    const res = await app.request("/abort");
    expect(res.status).toBe(499);
    expect(await res.text()).toBe("");
    // Logged as info (client_disconnect), NOT as an error.
    expect(lines.some((l) => l.message === "request.client_disconnect")).toBe(true);
    expect(lines.some((l) => l.level === "error")).toBe(false);
  });

  it("handleError maps a non-Error value to a redacted upstream_error(502)", async () => {
    // Hono never delivers a non-Error to onError, but the handler is called directly
    // from SSE paths; a bare value must not be treated as a disconnect and must
    // redact to upstream_error (covers the isClientDisconnect non-Error fall-through).
    const { logger, lines } = fakeLogger();
    const c = mockCtx(logger, "trace-direct");
    const res = handleError("a bare string, not an Error", c);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.trace_id).toBe("trace-direct");
    expect(lines.some((l) => l.level === "error")).toBe(true);
  });

  it("openAIErrorEnvelope builds the canonical {status, body} envelope (SSE-path reuse)", () => {
    const { status, body } = openAIErrorEnvelope({
      error_class: "rate_limited",
      message: "slow down",
      trace_id: "trace-env",
    });
    expect(status).toBe(429);
    expect(body.error).toMatchObject({
      type: "rate_limit_error",
      code: "rate_limited",
      trace_id: "trace-env",
    });
    expect(body.error.message).toBe("slow down");
  });

  it("does not mount /admin in createApp (server.ts wires it) nor shadow other routes", async () => {
    const { logger } = fakeLogger();
    const app = createApp({ logger });
    app.get("/v1/ping", (c) => c.text("pong"));
    // createApp no longer mounts /admin; it is wired by server.ts with the
    // resolved adminAuth + static SPA. So a bare app has no admin handler.
    expect((await app.request("/admin")).status).toBe(404);
    expect(await (await app.request("/v1/ping")).text()).toBe("pong");
    // the built-in /healthz is still reachable.
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
