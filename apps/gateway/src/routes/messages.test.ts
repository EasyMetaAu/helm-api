import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  type MessagesIdentity,
  type MessagesRouteDeps,
  registerMessagesRoute,
} from "./messages.js";

// POST /v1/messages — Anthropic Messages inbound. These tests pin the route's
// CONTRACT: auth → translate(out) → route → translate(back), with all business
// logic stubbed. The route file must be PURE HTTP glue (CLAUDE.md principle 1):
// no classify/route/translate logic lives in it; it only wires the injected deps.

const AUTH = { "x-api-key": "helm_live_secret", "Content-Type": "application/json" };

const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };

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
}

function makeDeps(
  over: {
    collect?: () => Promise<unknown>;
    streamEvents?: () => AsyncIterable<{ type: string; [k: string]: unknown }>;
    isStream?: boolean;
    failOpen?: boolean;
    abort?: boolean;
    authed?: boolean;
  } = {},
): { deps: MessagesRouteDeps; harness: Harness } {
  const harness: Harness = {
    order: [],
    pipelineSawIR: null,
    pipelineSawAbort: false,
    classifyThrew: false,
  };

  const deps: MessagesRouteDeps = {
    auth: {
      resolve: async (_key: string | null) => {
        harness.order.push("auth");
        return over.authed === false ? null : IDENTITY;
      },
    },
    transformers: {
      anthropic: {
        transformRequestOut: (native: unknown) => {
          harness.order.push("translate-out");
          const ir = fakeIR(over.isStream === true);
          // carry a marker so we can assert the SAME object reached the pipeline
          (ir as { __native?: unknown }).__native = native;
          return ir;
        },
        transformResponseOut: (ir: unknown) => {
          harness.order.push("translate-back");
          return { ...ANTHROPIC_RESPONSE, __ir: ir };
        },
        transformStreamOut: (ev: { type: string }) => ({
          event: ev.type,
          data: JSON.stringify(ev),
        }),
        transformErrorOut: (err: { error_class: string; message: string; trace_id: string }) => ({
          status: err.error_class === "auth_error" ? 401 : 502,
          body: {
            type: "error",
            error: {
              type: err.error_class === "auth_error" ? "authentication_error" : "api_error",
              message: err.message,
            },
          },
        }),
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
  return { deps, harness };
}

function buildApp(deps: MessagesRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  registerMessagesRoute(app, deps);
  return app;
}

const REQ_BODY = {
  model: "claude-3-5-sonnet",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 64,
};

describe("POST /v1/messages (Anthropic inbound)", () => {
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
});
