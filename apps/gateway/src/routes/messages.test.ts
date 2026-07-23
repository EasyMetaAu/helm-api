import type { TelemetryStore, UpsertSessionRevisionInput } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createBodyMemoryAdmission } from "../runtime/memory-admission.js";
import {
  type MessagesIdentity,
  type MessagesRouteDeps,
  registerMessagesRoute,
} from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import type { RecordServedDeps } from "./payload-capture.js";

// POST /v1/messages — Anthropic Messages inbound. These tests pin the route's
// CONTRACT: auth → translate(out) → route → translate(back), with all business
// logic stubbed. The route file must be PURE HTTP glue (CLAUDE.md principle 1):
// no classify/route/translate logic lives in it; it only wires the injected deps.

const AUTH = { "x-api-key": "helm_live_secret", "Content-Type": "application/json" };

const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };

// A fake DecisionRecord stand-in the route hands opaquely to recordServed →
// redact → telemetry.insert (it never inspects fields).
function fakeDecision() {
  return {
    final: {
      status: "ok",
      model_alias: "claude-3-5-sonnet",
      provider_model: "claude",
      error_reason: null,
    },
  } as never;
}

// A minimal IR-ish object the stub transformer returns; the route must thread it
// to the pipeline untouched (save trace_id) and never inspect its internals.
function fakeIR(stream: boolean): Record<string, unknown> {
  return {
    model: "claude-3-5-sonnet",
    messages: [{ role: "user", content: "hi" }],
    stream,
    metadata: {},
  };
}

// A canned Anthropic-native response the stub responseOut produces.
const ANTHROPIC_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
};

interface Harness {
  order: string[];
  pipelineSawIR: Record<string, unknown> | null;
  pipelineSawAbort: boolean;
  classifyThrew: boolean;
  responseOptions: unknown;
}

function makeDeps(
  over: {
    collect?: () => Promise<unknown>;
    streamEvents?: () => AsyncIterable<Record<string, unknown>>;
    isStream?: boolean;
    failOpen?: boolean;
    abort?: boolean;
    authed?: boolean;
    transformRequestOut?: (native: unknown) => unknown;
    countTokens?: MessagesRouteDeps["countTokens"];
    rateLimiter?: MessagesRouteDeps["rateLimiter"];
    concurrencyGate?: MessagesRouteDeps["concurrencyGate"];
    identity?: MessagesIdentity;
    record?: RecordServedDeps;
    memoryAdmission?: MessagesRouteDeps["memoryAdmission"];
    // Native passthrough (#217 C3): when true the stubbed pipeline run reports
    // nativePassthrough so the route must return collect()'s body UNTOUCHED (skip
    // transformResponseOut). collect() should be set to return the verbatim native body.
    nativePassthrough?: boolean;
    toolCallXmlRecoveryEnabled?: () => boolean;
  } = {},
): { deps: MessagesRouteDeps; harness: Harness } {
  const harness: Harness = {
    order: [],
    pipelineSawIR: null,
    pipelineSawAbort: false,
    classifyThrew: false,
    responseOptions: undefined,
  };

  const deps: MessagesRouteDeps = {
    rateLimiter: over.rateLimiter,
    concurrencyGate: over.concurrencyGate,
    countTokens: over.countTokens,
    record: over.record,
    memoryAdmission: over.memoryAdmission,
    toolCallXmlRecoveryEnabled: over.toolCallXmlRecoveryEnabled,
    auth: {
      resolve: async (_key: string | null) => {
        harness.order.push("auth");
        return over.authed === false ? null : (over.identity ?? IDENTITY);
      },
    },
    transformers: {
      anthropic: {
        transformRequestOut: (native: unknown) => {
          harness.order.push("translate-out");
          // The override may throw (structurally-invalid body case); when it
          // returns, narrow its loose shape to the IR the route threads onward.
          if (over.transformRequestOut)
            return over.transformRequestOut(native) as Record<string, unknown>;
          const ir = fakeIR(over.isStream === true);
          // carry a marker so we can assert the SAME object reached the pipeline
          (ir as { __native?: unknown }).__native = native;
          return ir;
        },
        transformResponseOut: (ir: unknown, options?: unknown) => {
          harness.order.push("translate-back");
          harness.responseOptions = options;
          return { ...ANTHROPIC_RESPONSE, __ir: ir };
        },
        transformStreamOut: (ev: { type: string }) => ({
          event: ev.type,
          data: JSON.stringify(ev),
        }),
        transformErrorOut: (err: { error_class: string; message: string; trace_id: string }) => {
          // Mirror makeAnthropicError's class→status/type mapping for the classes
          // the route emits (auth_error/invalid_request/rate_limited/…); the rest
          // collapse to api_error(502).
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
        },
      },
    },
    pipeline: {
      run: async (ir: Record<string, unknown>, _identity: unknown, signal: AbortSignal) => {
        harness.order.push("route");
        harness.pipelineSawIR = ir;
        if (over.failOpen === true && !harness.classifyThrew) {
          // emulate a fail-open auxiliary error already swallowed by core: the
          // pipeline still resolves with a degraded result (never 5xx).
          harness.classifyThrew = true;
        }
        if (over.abort === true) {
          if (signal.aborted) harness.pipelineSawAbort = true;
          signal.addEventListener("abort", () => {
            harness.pipelineSawAbort = true;
          });
        }
        return {
          decision: fakeDecision(),
          collect: over.collect ?? (async () => ({ id: "ir-resp" })),
          streamIR:
            over.streamEvents ??
            async function* () {
              yield { type: "message_start" };
            },
          ...(over.nativePassthrough === true ? { nativePassthrough: true } : {}),
        };
      },
    },
  };
  return { deps, harness };
}

function buildApp(deps: MessagesRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  registerMessagesRoute(app, deps);
  return app;
}

// Recording dep with insert + insertPayload spies (mirrors the chat telemetry
// harness). redact is the identity so a test can assert it ran on the decision.
function makeRecord(over: { capturePayloads?: boolean; captureSessions?: boolean } = {}): {
  record: RecordServedDeps;
  insert: ReturnType<typeof vi.fn>;
  insertPayload: ReturnType<typeof vi.fn>;
  upsertSessionRevision: ReturnType<typeof vi.fn>;
  redact: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn().mockResolvedValue({ id: "1" });
  const insertPayload = vi.fn().mockResolvedValue(undefined);
  const upsertSessionRevision = vi.fn(async (_input: UpsertSessionRevisionInput) => {});
  const redact = vi.fn((x: unknown) => x);
  const record: RecordServedDeps = {
    telemetry: {
      insert,
      insertPayload,
      getSessionByRef: vi.fn(async () => null),
      listSessionRevisions: vi.fn(async () => []),
      upsertSessionRevision,
    } as unknown as TelemetryStore,
    redact: redact as never,
    now: () => 1000,
    capturePayloads: () => over.capturePayloads ?? true,
    captureSessions: () => over.captureSessions ?? false,
  };
  return { record, insert, insertPayload, upsertSessionRevision, redact };
}

const REQ_BODY = {
  model: "claude-3-5-sonnet",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 64,
};

function expectNativeCarrier(
  value: unknown,
  protocol: "anthropic_messages",
  body: Record<string, unknown>,
): void {
  const carrier = value as {
    protocol?: unknown;
    body?: unknown;
    raw_body?: unknown;
    headers?: Record<string, string>;
    mutations?: unknown;
  };
  expect(carrier.protocol).toBe(protocol);
  expect(carrier.body).toEqual(body);
  expect(carrier.raw_body).toBe(JSON.stringify(body));
  expect(carrier.headers?.["content-type"]).toBe("application/json");
  expect(carrier.headers?.["x-api-key"]).toBe("helm_live_secret");
  expect(carrier.mutations).toEqual({});
}

describe("POST /v1/messages (Anthropic inbound)", () => {
  it("rejects oversized message and count-token bodies before JSON.parse", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1024,
      maxWireBytes: 1,
      jsonAmplification: 1,
    });
    const { deps, harness } = makeDeps({ memoryAdmission });
    const app = buildApp(deps);

    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(REQ_BODY),
      });
      expect(res.status).toBe(413);
    }
    expect(harness.order).toEqual(["auth", "auth"]);
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("returns 503 with Retry-After when the shared body budget is occupied", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1,
      maxWireBytes: 1024,
      jsonAmplification: 1,
    });
    const { deps, harness } = makeDeps({ memoryAdmission });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(harness.order).toEqual(["auth"]);
  });

  it("accepts the Claude Code event logging compatibility endpoint after auth", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/api/event_logging/batch", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ events: [{ type: "client_event" }] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(harness.order).toEqual(["auth"]);
    expect(harness.order).not.toContain("route");
  });

  it("requires auth on the event logging compatibility endpoint", async () => {
    const { deps, harness } = makeDeps({ authed: false });
    const app = buildApp(deps);

    const res = await app.request("/api/event_logging/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });

    expect(res.status).toBe(401);
    expect(harness.order).toEqual(["auth"]);
  });

  it("uses provider-backed Anthropic count_tokens when available", async () => {
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 42 });
    const { deps, harness } = makeDeps({ countTokens });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 42 });
    expect(countTokens).toHaveBeenCalledWith(REQ_BODY, IDENTITY, expect.any(AbortSignal));
    expect(harness.order).toEqual(["auth"]);
    expect(harness.order).not.toContain("route");
  });

  it("returns an authenticated Anthropic count_tokens estimate without routing when no provider is available", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number; estimated: boolean };
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(body.estimated).toBe(true);
    expect(harness.order).toEqual(["auth"]);
    expect(harness.order).not.toContain("route");
  });

  it("falls back to an estimated Anthropic count_tokens result if provider counting fails", async () => {
    const countTokens = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const { deps, harness } = makeDeps({ countTokens });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number; estimated: boolean };
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(body.estimated).toBe(true);
    expect(countTokens).toHaveBeenCalledOnce();
    expect(harness.order).toEqual(["auth"]);
  });

  it("validates count_tokens requests before returning an estimate", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "claude-3-5-sonnet", messages: [] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("messages parameter is required");
    expect(harness.order).toEqual(["auth"]);
  });

  it("non-stream: auth → translate-out → route → translate-back, returns Anthropic JSON", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; content: unknown[] };
    expect(body.type).toBe("message");
    expect(body.content).toEqual([{ type: "text", text: "hello" }]);
    // The wiring order is a hard contract (docs/02 pipeline): auth FIRST.
    expect(harness.order).toEqual(["auth", "translate-out", "route", "translate-back"]);
  });

  it("threads the live XML-recovery flag and declared tool names into non-stream translation", async () => {
    const { deps, harness } = makeDeps({
      toolCallXmlRecoveryEnabled: () => false,
      transformRequestOut: () => ({
        ...fakeIR(false),
        tools: [
          { type: "function", function: { name: "Bash", parameters: {} } },
          { type: "function", function: { name: 42, parameters: {} } },
          { type: "other", name: "ignored" },
        ],
      }),
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(harness.responseOptions).toEqual({
      toolNames: ["Bash"],
      toolCallXmlRecoveryEnabled: false,
    });
  });

  it("rejects a missing/invalid key with a 401 Anthropic error and never routes", async () => {
    const { deps, harness } = makeDeps({ authed: false });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "wrong", "Content-Type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
    // Pipeline must never be reached for an unauthenticated request.
    expect(harness.order).not.toContain("route");
  });

  it("rejects a malformed JSON body with 400 invalid_request, after auth, without routing", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: "{not valid json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    // Auth ran first (contract), but the request never reached translate/route.
    expect(harness.order).toEqual(["auth"]);
  });

  it("stream: returns text/event-stream with a legal message_start … message_stop sequence", async () => {
    async function* events() {
      yield { type: "message_start" };
      yield { type: "content_block_start", index: 0 };
      yield { type: "content_block_delta", index: 0 };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta" };
      yield { type: "message_stop" };
    }
    const { deps } = makeDeps({ isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");
    // Order: start precedes delta precedes stop.
    expect(text.indexOf("message_start")).toBeLessThan(text.indexOf("content_block_delta"));
    expect(text.indexOf("content_block_delta")).toBeLessThan(text.indexOf("message_stop"));
  });

  it("passes tool_use blocks through stream events with a stable id/index", async () => {
    async function* events() {
      yield { type: "message_start" };
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_42", name: "get_weather", input: {} },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":1}' },
      };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_stop" };
    }
    const { deps } = makeDeps({ isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true, tools: [{ name: "get_weather" }] }),
    });
    const text = await res.text();
    expect(text).toContain("toolu_42");
    expect(text).toContain("tool_use");
    expect(text).toContain('"index":0');
  });

  it("threads the request trace_id onto the IR the pipeline receives", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: { ...AUTH, "x-trace-id": "trace-xyz" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(harness.pipelineSawIR).not.toBeNull();
    const meta = harness.pipelineSawIR?.metadata as { trace_id?: string } | undefined;
    expect(meta?.trace_id).toBe("trace-xyz");
  });

  it("fail-open: the pipeline degrades internally and still returns 2xx (never 5xx)", async () => {
    // The pipeline already swallows classify/eval/cache failures (core principle 3);
    // the route must surface whatever it returns as a normal response.
    const { deps } = makeDeps({ failOpen: true });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
  });

  it("a client disconnect signal reaches the pipeline (not recorded as a provider fault)", async () => {
    const { deps, harness } = makeDeps({ abort: true });
    const app = buildApp(deps);
    const controller = new AbortController();

    const p = app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
      signal: controller.signal,
    });
    controller.abort();
    await Promise.resolve(p).catch(() => {});

    // The route must hand the per-request abort signal to the pipeline so the
    // executor can treat the disconnect as a non-provider fault.
    expect(harness.pipelineSawAbort).toBe(true);
  });

  it("maps the x-session-key header into ir.metadata.conversation_id (session momentum)", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: { ...AUTH, "x-session-key": "sess-xyz" },
      body: JSON.stringify(REQ_BODY),
    });

    const meta = (harness.pipelineSawIR?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.conversation_id).toBe("sess-xyz");
  });

  it("leaves conversation_id unset when no x-session-key header is present", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    const meta = (harness.pipelineSawIR?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.conversation_id).toBeUndefined();
  });

  it("maps a structurally invalid body (transformRequestOut throws) to a 400 Anthropic error", async () => {
    // The REAL Anthropic transformer throws a ZodError on e.g. {messages:[]}. The
    // route must wrap transformRequestOut and return the ANTHROPIC envelope (400),
    // not let the throw escape to onError → an OpenAI-shaped 502.
    const { deps, harness } = makeDeps({
      transformRequestOut: () => {
        throw new Error("messages: too_small");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(harness.order).not.toContain("route");
  });

  it("surfaces an all-providers-failed pipeline error as an Anthropic envelope (not an empty 200)", async () => {
    const { deps } = makeDeps({
      collect: async () => {
        throw new PipelineError("all_providers_failed", "all providers failed", "trace-1");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
  });

  it("emits a terminal Anthropic error event when the stream throws (non-abort)", async () => {
    async function* events(): AsyncIterable<{ type: string }> {
      yield { type: "message_start" };
      throw new Error("upstream blew up mid-stream");
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
    expect(text).toContain("event: message_start");
    // A terminal Anthropic error frame must follow the partial stream.
    expect(text).toContain("event: error");
  });

  it("429s an Anthropic rate_limited envelope when the concurrency gate rejects, without routing", async () => {
    const { deps, harness } = makeDeps({
      concurrencyGate: {
        acquire: async () => ({
          ok: false as const,
          reason: "queue_full" as const,
          retryAfterSeconds: 4,
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
    expect(res.headers.get("retry-after")).toBe("4");
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("error");
    expect(harness.order).not.toContain("route");
  });

  it("429s a throttled key on /v1/messages with an Anthropic rate_limited envelope", async () => {
    const limiter: MessagesRouteDeps["rateLimiter"] = {
      check: async () => ({
        allowed: false,
        limitedBy: "rpm",
        limit: 10,
        remaining: 0,
        resetSeconds: 30,
        retryAfterSeconds: 30,
      }),
    };
    const { deps, harness } = makeDeps({ rateLimiter: limiter });
    const app = buildApp(deps);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-ratelimit-limit")).toBe("10");
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    // Anthropic rate-limit envelope, and routing never ran.
    expect(harness.order).not.toContain("route");
  });

  it("threads the key's per-key rate-limit override into the limiter probe", async () => {
    let capturedOverride: unknown;
    const limiter: MessagesRouteDeps["rateLimiter"] = {
      check: async (probe) => {
        capturedOverride = probe.override;
        return {
          allowed: true,
          limitedBy: null,
          limit: 1,
          remaining: 0,
          resetSeconds: 30,
          retryAfterSeconds: 0,
        };
      },
    };
    const { deps } = makeDeps({
      rateLimiter: limiter,
      identity: { keyId: "k1", accountId: "acct", caps: { rateLimit: { rpm: 1, tpm: null } } },
    });
    const app = buildApp(deps);
    await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    expect(capturedOverride).toEqual({ rpm: 1, tpm: null });
  });

  it("does not 429 when the limiter allows the key", async () => {
    const limiter: MessagesRouteDeps["rateLimiter"] = {
      check: async () => ({
        allowed: true,
        limitedBy: null,
        limit: 10,
        remaining: 9,
        resetSeconds: 30,
        retryAfterSeconds: 0,
      }),
    };
    const { deps, harness } = makeDeps({ rateLimiter: limiter });
    const app = buildApp(deps);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(200);
    expect(harness.order).toContain("route");
  });

  // ── Telemetry recording (the /admin/requests bug). /v1/messages served LLM
  //    traffic but never recorded a telemetry row, so it was invisible in the
  //    admin Debug list. recordServed must fire on every served request.
  it("records a redacted telemetry row + payload for a served NON-STREAM request", async () => {
    const { record, insert, insertPayload, redact } = makeRecord();
    const { deps } = makeDeps({ record });
    const app = buildApp(deps);
    const rawRequest =
      '{\n  "model":"claude-3-5-sonnet",\n  "messages":[{"role":"user","content":"hi"}],\n  "max_tokens":64\n}';

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: rawRequest,
    });

    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
    const arg = insert.mock.calls[0]?.[0] as { apiKeyId: string };
    expect(arg.apiKeyId).toBe("k1");
    expect(redact).toHaveBeenCalled();
    // The plaintext key must never reach the persisted telemetry row.
    expect(JSON.stringify(arg)).not.toContain("helm_live_secret");
    expect(insertPayload).toHaveBeenCalledOnce();
    const payload = insertPayload.mock.calls[0]?.[0] as { requestJson: string };
    expect(payload.requestJson).toBe(rawRequest);
  });

  it("records a telemetry row for a served STREAM request after the stream drains", async () => {
    async function* events() {
      yield { type: "message_start" };
      yield { type: "message_stop" };
    }
    const { record, insert } = makeRecord();
    const { deps } = makeDeps({ record, isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });
    // Drain the stream fully so the finally (where recording lives) runs.
    await res.text();

    expect(insert).toHaveBeenCalledOnce();
    const arg = insert.mock.calls[0]?.[0] as { apiKeyId: string };
    expect(arg.apiKeyId).toBe("k1");
  });

  it("does not record when no record dep is wired (existing tests stay green)", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(200);
  });

  it("stores the successful non-stream response in the Session when payload capture is off", async () => {
    const { record, insertPayload, upsertSessionRevision } = makeRecord({
      capturePayloads: false,
      captureSessions: true,
    });
    const { deps } = makeDeps({ record });
    const app = buildApp(deps);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...AUTH, "x-thread-id": "thread-response" },
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(insertPayload).not.toHaveBeenCalled();
    expect(upsertSessionRevision).toHaveBeenCalledWith(
      expect.objectContaining({ responseJson: JSON.stringify(body) }),
    );
  });

  // ── Capture-payloads gating (review P2). With capture_payloads OFF the route
  //    must still write the telemetry row but NOT buffer/persist the body — the
  //    stream buffer is the unbounded growth vector this gate closes.
  it("capture_payloads OFF: a served stream records the telemetry row but NOT the payload", async () => {
    async function* events() {
      yield { type: "message_start" };
      yield { type: "message_stop" };
    }
    const { record, insert, insertPayload } = makeRecord({ capturePayloads: false });
    const { deps } = makeDeps({ record, isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });
    await res.text();

    expect(insert).toHaveBeenCalledOnce();
    expect(insertPayload).not.toHaveBeenCalled();
  });

  // ── Native protocol passthrough (#217 C3). When the pipeline reports
  //    nativePassthrough the route MUST return collect()'s body UNTOUCHED (skip
  //    transformResponseOut), so the verbatim Anthropic upstream body reaches the
  //    client byte-for-byte. The translate path (flag OFF / no passthrough) stays
  //    exactly as today.
  it("non-stream passthrough: returns the verbatim native body byte-for-byte, skipping translate-back", async () => {
    // The verbatim Anthropic-native upstream body the (stubbed) provider produced.
    const upstreamNative = {
      id: "msg_passthrough_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet",
      content: [{ type: "text", text: "verbatim native" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 0 },
    };
    const { record, insertPayload } = makeRecord({ capturePayloads: true });
    const { deps, harness } = makeDeps({
      record,
      nativePassthrough: true,
      collect: async () => upstreamNative,
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // BYTE-EQUALITY: the response handed to the client is the exact native upstream
    // body — no translate-back wrapper, no __ir marker the stub responseOut adds.
    expect(body).toEqual(upstreamNative);
    expect((body as { __ir?: unknown }).__ir).toBeUndefined();
    // translate-back (transformResponseOut) is BYPASSED on the passthrough path.
    expect(harness.order).toEqual(["auth", "translate-out", "route"]);
    expect(harness.order).not.toContain("translate-back");
    // request_payloads captures NATIVE on both ends: the response body is the native
    // upstream body, the request body is the raw inbound (also native).
    expect(insertPayload).toHaveBeenCalledOnce();
    const payload = insertPayload.mock.calls[0]?.[0] as {
      requestJson: string;
      responseJson: string;
    };
    expect(JSON.parse(payload.responseJson)).toEqual(upstreamNative);
    expect(JSON.parse(payload.requestJson)).toEqual(REQ_BODY);
  });

  it("stamps the verbatim parsed inbound body onto ir.metadata.native_request (non-stream)", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    const meta = (harness.pipelineSawIR?.metadata ?? {}) as { native_request?: unknown };
    // The core guard/executor reads a carrier: parsed body + raw body + client headers.
    expectNativeCarrier(meta.native_request, "anthropic_messages", REQ_BODY);
  });

  it("normalizes Claude Code date fingerprint markers before native passthrough", async () => {
    const incoming = {
      ...REQ_BODY,
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.197.abc; cc_entrypoint=cli; cch=12345;",
        },
        { type: "text", text: "Todayʹs date is 2026/07/01." },
      ],
      messages: [{ role: "user", content: "user marker: Today's date is 2026/07/02." }],
      tools: [
        {
          name: "date_check",
          description: "tool marker: Todayʼs date is 2026/07/03.",
          input_schema: { type: "object", properties: {} },
        },
      ],
    };
    const { record, insertPayload } = makeRecord({ capturePayloads: true });
    const { deps, harness } = makeDeps({ record });
    const app = buildApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(incoming),
    });

    const meta = (harness.pipelineSawIR?.metadata ?? {}) as { native_request?: unknown };
    const carrier = meta.native_request as {
      body?: {
        system?: Array<{ text?: string }>;
        messages?: Array<{ content?: string }>;
        tools?: Array<{ description?: string }>;
      };
      raw_body?: string;
      mutations?: { body_shims_applied?: string[] };
    };
    expect(carrier.body?.system?.[1]?.text).toBe("Today's date is 2026-07-01.");
    expect(carrier.body?.messages?.[0]?.content).toBe("user marker: Today's date is 2026-07-02.");
    expect(carrier.body?.tools?.[0]?.description).toBe("tool marker: Today's date is 2026-07-03.");
    const rawCarrier = JSON.parse(carrier.raw_body ?? "{}") as {
      system: Array<{ text?: string }>;
      messages: Array<{ content?: string }>;
      tools: Array<{ description?: string }>;
    };
    expect(rawCarrier.system[1]?.text).toBe("Today's date is 2026-07-01.");
    expect(rawCarrier.messages[0]?.content).toBe("user marker: Today's date is 2026-07-02.");
    expect(rawCarrier.tools[0]?.description).toBe("tool marker: Today's date is 2026-07-03.");
    expect(carrier.mutations?.body_shims_applied).toContain(
      "claude_code_date_fingerprint_normalized",
    );

    const payload = insertPayload.mock.calls[0]?.[0] as { requestJson: string };
    const captured = JSON.parse(payload.requestJson) as {
      system: Array<{ text?: string }>;
      messages: Array<{ content?: string }>;
      tools: Array<{ description?: string }>;
    };
    expect(captured.system[1]?.text).toBe("Todayʹs date is 2026/07/01.");
    expect(captured.messages[0]?.content).toBe("user marker: Today's date is 2026/07/02.");
    expect(captured.tools[0]?.description).toBe("tool marker: Todayʼs date is 2026/07/03.");
  });

  it("stamps native_request on a STREAMING request too (Phase 2 streaming passthrough)", async () => {
    // Phase 2: the carrier now covers streams. The native streaming body already
    // carries stream:true; the guard + executor decide whether to actually forward it.
    const { deps, harness } = makeDeps({ isStream: true });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });
    await res.text();

    const meta = (harness.pipelineSawIR?.metadata ?? {}) as { native_request?: unknown };
    expectNativeCarrier(meta.native_request, "anthropic_messages", { ...REQ_BODY, stream: true });
  });

  // ── Native protocol passthrough STREAMING (#217 Phase 2, C3). When the pipeline
  //    reports nativePassthrough on a STREAM, each yielded item is ALREADY an
  //    {event,data} frame carrying the VERBATIM upstream Anthropic data payload. The
  //    route MUST write it directly (skip transformStreamOut) so the bytes reach the
  //    client byte-for-byte. The translate path (flag OFF) stays exactly as today.
  it("stream passthrough: writes the VERBATIM upstream frames byte-for-byte (no transformStreamOut)", async () => {
    // Deliberately non-canonical spacing inside the data payload proves the route
    // forwards the {event,data} item directly instead of re-shaping it.
    const startData =
      '{"type":"message_start","message":{"id":"msg_x","usage":{ "input_tokens":7 }}}';
    const deltaData =
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}';
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "message_start", data: startData };
      yield { event: "content_block_delta", data: deltaData };
      yield { event: "message_stop", data: '{"type":"message_stop"}' };
    }
    const { record, insertPayload } = makeRecord({ capturePayloads: true });
    const { deps, harness } = makeDeps({
      record,
      isStream: true,
      nativePassthrough: true,
      streamEvents: events,
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // The verbatim data payloads (with their non-canonical spacing) reach the wire —
    // NOT the stub transformStreamOut shape (which would JSON.stringify the {type} bag).
    expect(text).toContain(`event: message_start\ndata: ${startData}`);
    expect(text).toContain(`event: content_block_delta\ndata: ${deltaData}`);
    expect(text).toContain("event: message_stop");
    // request_payloads captures the NATIVE frames verbatim on the response side.
    await Promise.resolve();
    expect(insertPayload).toHaveBeenCalledOnce();
    const payload = insertPayload.mock.calls[0]?.[0] as { responseJson: string };
    expect(payload.responseJson).toContain(`data: ${startData}`);
    // native_request stamped on the streaming IR (Phase 2 carrier).
    const meta = (harness.pipelineSawIR?.metadata ?? {}) as { native_request?: unknown };
    expectNativeCarrier(meta.native_request, "anthropic_messages", { ...REQ_BODY, stream: true });
  });

  it("stream NON-passthrough (flag OFF): still maps via transformStreamOut as today", async () => {
    async function* events() {
      yield { type: "message_start" };
      yield { type: "content_block_delta", index: 0 };
      yield { type: "message_stop" };
    }
    const { deps } = makeDeps({ isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });
    const text = await res.text();
    // The stub transformStreamOut maps {type} → {event:type, data:JSON.stringify(ev)},
    // so the data payload is the re-serialized IR event bag (translate path).
    expect(text).toContain("event: message_start");
    expect(text).toContain('data: {"type":"message_start"}');
    expect(text).toContain("event: content_block_delta");
  });

  it("non-stream NON-passthrough (default): still runs translate-back as today", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; __ir?: unknown };
    expect(body.type).toBe("message");
    // The translate-back transformer ran (stub stamps __ir onto the response).
    expect(body.__ir).toBeDefined();
    expect(harness.order).toEqual(["auth", "translate-out", "route", "translate-back"]);
  });

  // ── Terminal stream error frame must be appended to the captured body (review
  //    P2). A mid-stream upstream error writes an `event: error` frame to the
  //    client; that frame has to land in the persisted responseJson too.
  it("stream error frame is captured in the payload", async () => {
    async function* events(): AsyncIterable<{ type: string }> {
      yield { type: "message_start" };
      throw new Error("upstream blew up mid-stream");
    }
    const { record, insertPayload } = makeRecord({ capturePayloads: true });
    const { deps } = makeDeps({ record, isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });
    await res.text();

    expect(insertPayload).toHaveBeenCalledOnce();
    const arg = insertPayload.mock.calls[0]?.[0] as { responseJson: string };
    expect(arg.responseJson).toContain("event: error");
    expect(arg.responseJson).toContain("error");
  });

  it("stream error frame marks the persisted decision as error", async () => {
    async function* events(): AsyncIterable<{ type: string }> {
      yield { type: "message_start" };
      throw new Error("upstream blew up mid-stream");
    }
    const { record, insert } = makeRecord({ capturePayloads: true });
    const { deps } = makeDeps({ record, isStream: true, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ_BODY, stream: true }),
    });
    await res.text();

    expect(insert).toHaveBeenCalledOnce();
    const arg = insert.mock.calls[0]?.[0] as {
      decision: { final: { status: string; error_reason: string | null } };
    };
    expect(arg.decision.final.status).toBe("error");
    expect(arg.decision.final.error_reason).toBe("upstream_error");
  });
});
