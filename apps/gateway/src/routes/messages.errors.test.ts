import { UpstreamError } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  type MessagesIdentity,
  type MessagesRouteDeps,
  registerMessagesRoute,
} from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import type { RecordServedDeps } from "./payload-capture.js";

// Supplemental error/edge coverage for POST /v1/messages (Anthropic inbound).
// These pin the route's FAIL-CLOSED / FAIL-OPEN error branches not exercised by
// messages.test.ts: the count_tokens guard rejections, the Bearer credential
// fallback, the run()-throws-PipelineError path, the non-stream collect() error
// (record-then-surface), and the stream-catch error class selection (PipelineError
// vs upstream_error vs mid-stream timeout). All business logic is stubbed — the
// route stays pure HTTP glue (CLAUDE.md principle 1).

const AUTH = { "x-api-key": "helm_live_secret", "Content-Type": "application/json" };
const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };
const FAKE_DECISION = { final: { status: "ok", model_alias: "claude-3-5-sonnet" } } as never;

const REQ_BODY = {
  model: "claude-3-5-sonnet",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 64,
};

function fakeIR(stream: boolean): Record<string, unknown> {
  return {
    model: "claude-3-5-sonnet",
    messages: [{ role: "user", content: "hi" }],
    stream,
    metadata: {},
  };
}

// The same class→status/type mapping messages.test.ts uses so the asserted
// envelopes match the real makeAnthropicError contract for the classes the route
// emits (auth_error/invalid_request/rate_limited/timeout/…).
function transformErrorOut(err: { error_class: string; message: string; trace_id: string }) {
  const status =
    err.error_class === "auth_error"
      ? 401
      : err.error_class === "invalid_request"
        ? 400
        : err.error_class === "rate_limited"
          ? 429
          : 502;
  const type =
    err.error_class === "auth_error"
      ? "authentication_error"
      : err.error_class === "invalid_request"
        ? "invalid_request_error"
        : err.error_class === "rate_limited"
          ? "rate_limit_error"
          : "api_error";
  return { status, body: { type: "error", error: { type, message: err.message } } };
}

interface Over {
  collect?: () => Promise<unknown>;
  streamEvents?: () => AsyncIterable<Record<string, unknown>>;
  isStream?: boolean;
  authed?: boolean;
  runThrows?: unknown;
  concurrencyGate?: MessagesRouteDeps["concurrencyGate"];
  identity?: MessagesIdentity;
  record?: RecordServedDeps;
}

function makeDeps(over: Over = {}): {
  deps: MessagesRouteDeps;
  order: string[];
} {
  const order: string[] = [];
  const deps: MessagesRouteDeps = {
    concurrencyGate: over.concurrencyGate,
    record: over.record,
    auth: {
      resolve: async () => {
        order.push("auth");
        return over.authed === false ? null : (over.identity ?? IDENTITY);
      },
    },
    transformers: {
      anthropic: {
        transformRequestOut: () => {
          order.push("translate-out");
          return fakeIR(over.isStream === true);
        },
        transformResponseOut: (ir: unknown) => {
          order.push("translate-back");
          return { id: "msg_1", type: "message", __ir: ir };
        },
        transformStreamOut: (ev: { type: string }) => ({
          event: ev.type,
          data: JSON.stringify(ev),
        }),
        transformErrorOut,
      },
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
              yield { type: "message_start" };
            },
        };
      },
    },
  };
  return { deps, order };
}

function buildApp(deps: MessagesRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  registerMessagesRoute(app, deps);
  return app;
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

describe("POST /v1/messages — auth + credential extraction edges", () => {
  it("authenticates via the Authorization: Bearer header when x-api-key is absent", async () => {
    let sawCredential: string | null | undefined;
    const { deps, order } = makeDeps({
      identity: IDENTITY,
    });
    // Wrap auth.resolve to capture the credential the route extracted from Bearer.
    const inner = deps.auth.resolve;
    deps.auth.resolve = async (cred) => {
      sawCredential = cred;
      return inner(cred);
    };
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer helm_bearer_key", "Content-Type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    // The Bearer token (not the literal header) reached the resolver.
    expect(sawCredential).toBe("helm_bearer_key");
    expect(order).toContain("route");
  });

  it("treats a malformed Authorization header (no Bearer prefix) as a missing credential → 401", async () => {
    let sawCredential: string | null | undefined;
    const { deps } = makeDeps({ authed: false });
    const inner = deps.auth.resolve;
    deps.auth.resolve = async (cred) => {
      sawCredential = cred;
      return inner(cred);
    };
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { Authorization: "Token nope", "Content-Type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(401);
    // A non-Bearer Authorization header yields a null credential (no key extracted).
    expect(sawCredential).toBeNull();
  });
});

describe("POST /v1/messages/count_tokens — guard rejections", () => {
  it("rejects an unauthenticated count_tokens request with 401", async () => {
    const { deps, order } = makeDeps({ authed: false });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(order).toEqual(["auth"]);
  });

  it("rejects a malformed JSON body on count_tokens with 400 invalid_request", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: AUTH,
      body: "{not json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("malformed JSON");
  });

  it("rejects count_tokens when the model parameter is missing/empty", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("model parameter is required");
  });

  it("estimates input_tokens over nested system/messages/tools structures", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);

    // A deeply nested body exercises the recursive collector (arrays + objects).
    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "claude-3-5-sonnet",
        system: [{ type: "text", text: "you are helpful" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "a long-ish prompt body here" }] },
        ],
        tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object" } }],
        tool_choice: { type: "auto" },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(1);
  });
});

describe("POST /v1/messages — concurrency wait-timeout rejection", () => {
  it("429s with a wait-timeout message when the concurrency gate times out", async () => {
    const { deps, order } = makeDeps({
      concurrencyGate: {
        acquire: async () => ({
          ok: false as const,
          // A wait timeout (reason !== "queue_full") → the "timed out waiting" message.
          reason: "timeout" as const,
          retryAfterSeconds: 7,
        }),
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("timed out waiting for a concurrency slot");
    // The gate rejected BEFORE routing.
    expect(order).not.toContain("route");
  });

  it("acquires a slot and routes when the concurrency gate allows", async () => {
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

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(order).toContain("route");
    // The unclaimed lease is freed by concurrencyReleaseGuard on the non-stream exit.
    expect(released).toBe(true);
  });
});

describe("POST /v1/messages — run() raises a PipelineError", () => {
  it("maps a PipelineError(invalid_request) from run() to a 400 Anthropic envelope", async () => {
    const { deps, order } = makeDeps({
      runThrows: new PipelineError("invalid_request", "messages must be a non-empty array", "t-1"),
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("non-empty array");
    expect(order).toEqual(["auth", "translate-out", "route"]);
  });

  it("re-throws a non-PipelineError from run() to the global onError (5xx)", async () => {
    const { deps } = makeDeps({ runThrows: new Error("unexpected core crash") });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    // A non-PipelineError escapes run()'s catch → the app's onError handler.
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /v1/messages — non-stream collect() failure", () => {
  it("records the failed request then surfaces the PipelineError envelope (non-stream)", async () => {
    const { record, insert, insertPayload } = makeRecord();
    const { deps } = makeDeps({
      record,
      collect: async () => {
        throw new PipelineError("all_providers_failed", "all providers failed", "t-2");
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("api_error");
    // The failed served request is still recorded (→ /admin/requests) with no body.
    expect(insert).toHaveBeenCalledOnce();
    expect(insertPayload).toHaveBeenCalledOnce();
    const payload = insertPayload.mock.calls[0]?.[0] as { responseJson: string | null };
    expect(payload.responseJson).toBeNull();
  });

  it("re-throws a non-PipelineError from collect() to onError (5xx) and still records", async () => {
    const { record, insert } = makeRecord();
    const { deps } = makeDeps({
      record,
      collect: async () => {
        throw new Error("transformResponseOut blew up");
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
    // Fail-open: the failed request was still recorded before the throw.
    expect(insert).toHaveBeenCalledOnce();
  });
});

describe("POST /v1/messages — stream-catch error classification", () => {
  it("emits a PipelineError's class/message as the terminal error frame", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { type: "message_start" };
      throw new PipelineError("all_providers_failed", "all providers failed mid-stream", "t-3");
    }
    const { deps } = makeDeps({ isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    // The terminal frame carries the PipelineError's own message, not a generic one.
    expect(text).toContain("all providers failed mid-stream");
  });

  it("maps a mid-stream UpstreamError('timeout') to a timeout terminal frame", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { type: "message_start" };
      throw new UpstreamError("timeout", "idle stall");
    }
    const { deps } = makeDeps({ isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });

    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("upstream timed out");
  });

  it("maps a generic mid-stream Error to an upstream_error terminal frame", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { type: "message_start" };
      throw new Error("socket reset");
    }
    const { deps } = makeDeps({ isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });

    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("upstream error");
  });

  it("suppresses the terminal error frame for a benign client disconnect (aborted signal)", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { type: "message_start" };
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const { deps } = makeDeps({ isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });

    const text = await res.text();
    // The benign abort yields NO terminal error frame (docs/02 — not a provider fault).
    expect(text).toContain("event: message_start");
    expect(text).not.toContain("event: error");
  });
});
