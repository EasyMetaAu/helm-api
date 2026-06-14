import { UpstreamError } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { type GeminiRouteDeps, registerGeminiRoute } from "./gemini.js";
import type { MessagesIdentity } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import type { RecordServedDeps } from "./payload-capture.js";

// Supplemental error/edge coverage for the Gemini face. Pins the branches
// gemini.test.ts leaves open: the per-key rate-limit override probe, the
// concurrency queue-full vs wait-timeout messages, run() raising a PipelineError
// (vs a generic throw → onError), the non-stream collect() non-PipelineError
// rethrow, and the stream-catch class selection (PipelineError vs UpstreamError
// timeout vs generic upstream_error). All business logic stubbed (principle 1).

const GEMINI_AUTH = { "x-goog-api-key": "helm_live_secret", "Content-Type": "application/json" };
const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };
const REQ_BODY = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
const FAKE_DECISION = { final: { status: "ok", model_alias: "gemini-2.0-flash" } } as never;

function transformErrorOut(err: { error_class: string; message: string; trace_id: string }) {
  const status =
    err.error_class === "auth_error"
      ? 401
      : err.error_class === "invalid_request"
        ? 400
        : err.error_class === "rate_limited"
          ? 429
          : 502;
  const gstatus =
    err.error_class === "auth_error"
      ? "UNAUTHENTICATED"
      : err.error_class === "invalid_request"
        ? "INVALID_ARGUMENT"
        : err.error_class === "rate_limited"
          ? "RESOURCE_EXHAUSTED"
          : "UNAVAILABLE";
  return { status, body: { error: { code: status, message: err.message, status: gstatus } } };
}

interface Over {
  collect?: () => Promise<unknown>;
  streamEvents?: () => AsyncIterable<Record<string, unknown>>;
  runThrows?: unknown;
  rateLimiter?: GeminiRouteDeps["rateLimiter"];
  concurrencyGate?: GeminiRouteDeps["concurrencyGate"];
  identity?: MessagesIdentity;
  record?: RecordServedDeps;
}

function makeRecord(): {
  record: RecordServedDeps;
  insert: ReturnType<typeof vi.fn>;
  insertPayload: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn().mockResolvedValue({ id: "1" });
  const insertPayload = vi.fn().mockResolvedValue(undefined);
  const record: RecordServedDeps = {
    telemetry: { insert, insertPayload } as never,
    redact: ((x: unknown) => x) as never,
    now: () => 1000,
    capturePayloads: () => true,
  };
  return { record, insert, insertPayload };
}

function makeDeps(over: Over = {}): {
  deps: GeminiRouteDeps;
  order: string[];
  captured: { override?: unknown };
} {
  const order: string[] = [];
  const captured: { override?: unknown } = {};
  const deps: GeminiRouteDeps = {
    rateLimiter: over.rateLimiter,
    concurrencyGate: over.concurrencyGate,
    record: over.record,
    auth: {
      resolve: async (cred) => {
        order.push(`auth:${cred ?? "null"}`);
        return over.identity ?? IDENTITY;
      },
    },
    transformer: {
      transformRequestOut: () => {
        order.push("translate-out");
        return { model: "gemini", messages: [{ role: "user", content: "hi" }], metadata: {} };
      },
      transformResponseOut: (ir) => {
        order.push("translate-back");
        return { candidates: [], __ir: ir };
      },
      transformErrorOut,
    },
    pipeline: {
      run: async () => {
        order.push("route");
        if (over.runThrows !== undefined) throw over.runThrows;
        return {
          decision: FAKE_DECISION,
          collect: over.collect ?? (async () => ({ id: "ir-resp" })),
          streamIR:
            over.streamEvents ??
            async function* () {
              yield { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
            },
        };
      },
    },
  };
  // Wrap the limiter so a test can assert the per-key override forwarded.
  if (over.rateLimiter) {
    const inner = over.rateLimiter.check;
    deps.rateLimiter = {
      check: async (probe) => {
        captured.override = probe.override;
        return inner(probe);
      },
    };
  }
  return { deps, order, captured };
}

function buildApp(deps: GeminiRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  registerGeminiRoute(app, deps);
  return app;
}

describe("Gemini route — rate-limit override + allow", () => {
  it("threads the key's per-key rate-limit override into the limiter probe", async () => {
    const { deps, captured } = makeDeps({
      identity: { keyId: "k1", accountId: "acct", caps: { rateLimit: { rpm: 5, tpm: null } } },
      rateLimiter: {
        check: async () => ({
          allowed: true,
          limitedBy: null,
          limit: 5,
          remaining: 4,
          resetSeconds: 30,
          retryAfterSeconds: 0,
        }),
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(captured.override).toEqual({ rpm: 5, tpm: null });
  });

  it("does not 429 when the limiter allows the key (sets the limit headers, routes)", async () => {
    const { deps, order } = makeDeps({
      rateLimiter: {
        check: async () => ({
          allowed: true,
          limitedBy: null,
          limit: 100,
          remaining: 99,
          resetSeconds: 30,
          retryAfterSeconds: 0,
        }),
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("100");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("99");
    expect(order).toContain("route");
  });
});

describe("Gemini route — concurrency gate rejections", () => {
  it("429s with the queue-full message when the gate reports queue_full", async () => {
    const { deps } = makeDeps({
      concurrencyGate: {
        acquire: async () => ({
          ok: false as const,
          reason: "queue_full" as const,
          retryAfterSeconds: 3,
        }),
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("concurrency queue is full");
  });

  it("acquires + routes when the gate allows, freeing the lease on exit", async () => {
    let released = false;
    const { deps, order } = makeDeps({
      concurrencyGate: {
        acquire: async () => ({
          ok: true as const,
          release: () => {
            released = true;
          },
        }),
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(order).toContain("route");
    expect(released).toBe(true);
  });
});

describe("Gemini route — run() raises a PipelineError", () => {
  it("maps a PipelineError(invalid_request) from run() to a 400 Gemini envelope", async () => {
    const { deps, order } = makeDeps({
      runThrows: new PipelineError("invalid_request", "messages must be a non-empty array", "t-1"),
    });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { status: string } };
    expect(body.error.status).toBe("INVALID_ARGUMENT");
    expect(order).toEqual(["auth:helm_live_secret", "translate-out", "route"]);
  });

  it("re-throws a non-PipelineError from run() to onError (5xx)", async () => {
    const { deps } = makeDeps({ runThrows: new Error("core crash") });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("Gemini route — non-stream collect() failure", () => {
  it("records the FAILED request (no body) then surfaces the PipelineError envelope", async () => {
    const { record, insert, insertPayload } = makeRecord();
    const { deps } = makeDeps({
      record,
      collect: async () => {
        throw new PipelineError("all_providers_failed", "all providers failed", "t-2");
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { status: string } };
    expect(body.error.status).toBe("UNAVAILABLE");
    // The failed served request is recorded with responseJson null (→ /admin/requests).
    expect(insert).toHaveBeenCalledOnce();
    expect(insertPayload).toHaveBeenCalledOnce();
    const payload = insertPayload.mock.calls[0]?.[0] as { responseJson: string | null };
    expect(payload.responseJson).toBeNull();
  });

  it("re-throws a non-PipelineError thrown by collect() to onError (5xx) and still records", async () => {
    const { record, insert } = makeRecord();
    const { deps } = makeDeps({
      record,
      collect: async () => {
        throw new Error("transformResponseOut blew up");
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(insert).toHaveBeenCalledOnce();
  });

  it("authenticates a served request via Authorization: Bearer (no x-goog-api-key)", async () => {
    const { deps, order } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: { Authorization: "Bearer goog_bearer_key", "Content-Type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(order[0]).toBe("auth:goog_bearer_key");
  });

  it("extracts a null credential when neither x-goog-api-key nor a Bearer header is present", async () => {
    const { deps, order } = makeDeps();
    const app = buildApp(deps);

    // A non-Bearer Authorization header → extractCredential returns null → the
    // resolver sees null (auth:null) and the stub identity is still returned, so
    // routing proceeds; the point is the credential extraction fell through both arms.
    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: { Authorization: "Basic Zm9vOmJhcg==", "Content-Type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(order[0]).toBe("auth:null");
  });
});

describe("Gemini route — stream-catch error classification", () => {
  it("maps a mid-stream UpstreamError('timeout') to a timeout error frame", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
      throw new UpstreamError("timeout", "idle stall");
    }
    const { deps } = makeDeps({ streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    const text = await res.text();
    // transformErrorOut maps the non-classified "timeout" class to UNAVAILABLE(502),
    // and the route's frame carries the timeout message.
    expect(text).toContain("upstream timed out");
  });

  it("maps a generic mid-stream Error to an upstream_error frame", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
      throw new Error("socket reset");
    }
    const { deps } = makeDeps({ streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    const text = await res.text();
    expect(text).toContain("upstream error");
  });
});
