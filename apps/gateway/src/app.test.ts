import { type ErrorClass, makeHelmError } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { LogFields, Logger, LogLevel } from "./logging.js";
import { HelmHttpError } from "./middleware/error-handler.js";

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
    const app = createApp({ logger });
    app.get("/ping", (c) => c.json({ trace: c.get("trace_id") }));
    const res = await app.request("/ping", { headers: { "X-Request-Id": "abc-123" } });
    expect(res.headers.get("X-Trace-Id")).toBe("abc-123");
    const body = (await res.json()) as { trace: string };
    expect(body.trace).toBe("abc-123");
    const completed = lines.find((l) => l.message === "request.completed");
    expect(completed?.fields.trace_id).toBe("abc-123");
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
    expect(typeof f.trace_id).toBe("string");
    expect(typeof f.duration_ms).toBe("number");
  });

  it("serializes a thrown HelmError to an OpenAI-shaped body", async () => {
    const { logger } = fakeLogger();
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
    expect(lines.some((l) => l.level === "error")).toBe(true);
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
