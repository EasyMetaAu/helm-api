import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { MessagesIdentity } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import { type ResponsesRouteDeps, registerResponsesRoute } from "./responses.js";

// POST /v1/responses contract: auth → translate(out) → route → translate(back),
// OpenAI error envelope, non-streaming only. All business logic is stubbed; the
// route must be pure HTTP glue (CLAUDE.md principle 1).

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

function makeDeps(
  over: {
    authed?: boolean;
    transformRequestOut?: (n: unknown) => { stream?: boolean; metadata?: Record<string, unknown> };
    collect?: () => Promise<unknown>;
    streamIR?: () => AsyncIterable<{ type: string; [k: string]: unknown }>;
    rateLimiter?: ResponsesRouteDeps["rateLimiter"];
    identity?: MessagesIdentity;
  } = {},
): { deps: ResponsesRouteDeps; order: string[] } {
  const order: string[] = [];
  const deps: ResponsesRouteDeps = {
    rateLimiter: over.rateLimiter,
    auth: {
      resolve: async (cred) => {
        order.push("auth");
        if (over.authed === false || cred === null) return null;
        return over.identity ?? { keyId: "k1", accountId: "acct" };
      },
    },
    transformer: {
      transformRequestOut:
        over.transformRequestOut ??
        ((native) => {
          order.push("translate-out");
          return { model: "auto", messages: [{ role: "user", content: "hi" }], __native: native };
        }),
      transformResponseOut: (ir) => {
        order.push("translate-back");
        return { id: "resp_1", object: "response", status: "completed", output: [], __ir: ir };
      },
      // Serialize ONE Responses SSE event into its wire event/data pair (mirrors
      // the server wiring: event = the response.* type, data = the whole event).
      transformStreamOut: (event) => ({
        event: (event as { type: string }).type,
        data: JSON.stringify(event),
      }),
    },
    pipeline: {
      run: async (_ir, _identity, _signal) => {
        order.push("route");
        return {
          collect: over.collect ?? (async () => ({ id: "ir-resp", choices: [] })),
          streamIR:
            over.streamIR ??
            async function* () {
              yield { type: "response.created", sequence_number: 0 };
              yield { type: "response.completed", sequence_number: 1 };
            },
        };
      },
    },
  };
  return { deps, order };
}

// Parse an SSE response body into [event, dataJSON] frames.
function parseSSE(text: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    frames.push({ event, data });
  }
  return frames;
}

function buildApp(deps: ResponsesRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  registerResponsesRoute(app, deps);
  return app;
}

const REQ = { model: "auto", input: "Say hello", max_output_tokens: 16 };

describe("POST /v1/responses (OpenAI Responses inbound)", () => {
  it("non-stream: auth → translate-out → route → translate-back, returns Responses JSON", async () => {
    const { deps, order } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; status: string };
    expect(body.object).toBe("response");
    expect(order).toEqual(["auth", "translate-out", "route", "translate-back"]);
  });

  it("rejects a missing key with 401 (OpenAI error envelope) and never routes", async () => {
    const { deps, order } = makeDeps({ authed: false });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "invalid_request_error",
    );
    expect(order).not.toContain("route");
  });

  it("rejects a malformed JSON body with 400 invalid_request, without routing", async () => {
    const { deps, order } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(order).not.toContain("route");
  });

  it("stream:true returns text/event-stream with the response.* event sequence (no 400)", async () => {
    const { deps } = makeDeps({
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseSSE(await res.text());
    expect(frames[0]?.event).toBe("response.created");
    expect(frames.at(-1)?.event).toBe("response.completed");
    // No [DONE] sentinel on the Responses surface.
    expect(frames.some((f) => f.data === "[DONE]")).toBe(false);
  });

  it("mid-stream provider failure emits exactly one Responses-shaped error frame", async () => {
    const { deps } = makeDeps({
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      streamIR: async function* () {
        yield { type: "response.created", sequence_number: 0 };
        throw new Error("upstream exploded");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    expect(res.status).toBe(200);
    const frames = parseSSE(await res.text());
    const errorFrames = frames.filter((f) => f.event === "error");
    expect(errorFrames).toHaveLength(1);
    const env = JSON.parse(errorFrames[0]?.data ?? "{}") as {
      type: string;
      code: string;
      message: string;
      param: null;
      sequence_number: number;
    };
    expect(env).toMatchObject({ type: "error", code: "internal_error", param: null });
    expect(env.message).toBe("upstream exploded");
    expect(typeof env.sequence_number).toBe("number");
  });

  it("pre-stream all_providers_failed surfaces a single terminal Responses-shaped error frame", async () => {
    const { deps } = makeDeps({
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      // biome-ignore lint/correctness/useYield: throw-only generator (failure before first event)
      streamIR: async function* () {
        throw new PipelineError("all_providers_failed", "all providers failed", "trace-1");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    const frames = parseSSE(await res.text());
    const errorFrames = frames.filter((f) => f.event === "error");
    expect(errorFrames).toHaveLength(1);
    const env = JSON.parse(errorFrames[0]?.data ?? "{}") as {
      type: string;
      code: string;
      param: null;
    };
    expect(env).toMatchObject({ type: "error", code: "all_providers_failed", param: null });
  });

  it("client abort emits NO error frame (benign non-provider fault)", async () => {
    const ac = new AbortController();
    const { deps } = makeDeps({
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      streamIR: async function* () {
        yield { type: "response.created", sequence_number: 0 };
        ac.abort();
        throw new Error("aborted");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
      signal: ac.signal,
    });
    const frames = parseSSE(await res.text());
    expect(frames.some((f) => f.event === "error")).toBe(false);
  });

  it("maps a structurally invalid Responses body (transformer throws) to 400", async () => {
    const { deps, order } = makeDeps({
      transformRequestOut: () => {
        throw new Error("input: Required");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "auto" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(order).not.toContain("route");
  });

  it("surfaces an all-providers-failed pipeline error as an OpenAI envelope (not an empty 200)", async () => {
    const { deps } = makeDeps({
      collect: async () => {
        throw new PipelineError("all_providers_failed", "all providers failed", "trace-1");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("all_providers_failed");
  });

  it("maps an invalid_request pipeline error (empty request) to a 400 OpenAI envelope", async () => {
    const { deps } = makeDeps({
      collect: async () => {
        throw new PipelineError("invalid_request", "messages must be a non-empty array", "trace-1");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("429s a throttled key on /v1/responses (OpenAI rate_limited envelope), never routes", async () => {
    const limiter: ResponsesRouteDeps["rateLimiter"] = {
      check: async () => ({
        allowed: false,
        limitedBy: "tpm",
        limit: 100,
        remaining: 0,
        resetSeconds: 12,
        retryAfterSeconds: 12,
      }),
    };
    const { deps, order } = makeDeps({ rateLimiter: limiter });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(order).not.toContain("route");
  });

  it("threads the key's per-key rate-limit override into the limiter probe", async () => {
    let capturedOverride: unknown;
    const limiter: ResponsesRouteDeps["rateLimiter"] = {
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
    await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(capturedOverride).toEqual({ rpm: 1, tpm: null });
  });
});
