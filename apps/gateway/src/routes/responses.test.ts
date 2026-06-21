import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { MessagesIdentity } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import type { RecordServedDeps } from "./payload-capture.js";
import { type ResponsesRouteDeps, registerResponsesRoute } from "./responses.js";

// POST /v1/responses contract: auth → translate(out) → route → translate(back),
// OpenAI error envelope, non-streaming only. All business logic is stubbed; the
// route must be pure HTTP glue (CLAUDE.md principle 1).

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

// A fake DecisionRecord stand-in: the route treats it as an opaque bag it hands
// to recordServed → redact → telemetry.insert (it never inspects fields). The
// `model_alias` marker lets a test assert the redacted decision actually rode the
// insert call.
const FAKE_DECISION = { final: { status: "ok", model_alias: "gpt-4o" } } as never;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function shortTimeout(): Promise<"timeout"> {
  return new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10));
}

function makeDeps(
  over: {
    authed?: boolean;
    transformRequestOut?: (n: unknown) => { stream?: boolean; metadata?: Record<string, unknown> };
    collect?: () => Promise<unknown>;
    streamIR?: () => AsyncIterable<{ [k: string]: unknown }>;
    nativePassthrough?: boolean;
    run?: ResponsesRouteDeps["pipeline"]["run"];
    rateLimiter?: ResponsesRouteDeps["rateLimiter"];
    concurrencyGate?: ResponsesRouteDeps["concurrencyGate"];
    identity?: MessagesIdentity;
    record?: RecordServedDeps;
    lifecycle?: ResponsesRouteDeps["lifecycle"];
    registry?: ResponsesRouteDeps["registry"];
  } = {},
): { deps: ResponsesRouteDeps; order: string[]; harness: { pipelineSawIR: unknown } } {
  const order: string[] = [];
  const harness: { pipelineSawIR: unknown } = { pipelineSawIR: null };
  const deps: ResponsesRouteDeps = {
    rateLimiter: over.rateLimiter,
    concurrencyGate: over.concurrencyGate,
    record: over.record,
    lifecycle: over.lifecycle,
    registry: over.registry,
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
      run:
        over.run ??
        (async (ir, _identity, _signal) => {
          order.push("route");
          harness.pipelineSawIR = ir;
          return {
            decision: FAKE_DECISION,
            ...(over.nativePassthrough === true ? { nativePassthrough: true } : {}),
            collect: over.collect ?? (async () => ({ id: "ir-resp", choices: [] })),
            streamIR:
              over.streamIR ??
              async function* () {
                yield { type: "response.created", sequence_number: 0 };
                yield { type: "response.completed", sequence_number: 1 };
              },
          };
        }),
    },
  };
  return { deps, order, harness };
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

// Build a recording dep with insert + insertPayload spies (mirrors the chat
// route's telemetry harness). `redact` is the identity so a test can assert it
// was invoked on the decision before persistence.
function makeRecord(over: { capturePayloads?: boolean } = {}): {
  record: RecordServedDeps;
  insert: ReturnType<typeof vi.fn>;
  insertPayload: ReturnType<typeof vi.fn>;
  redact: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn().mockResolvedValue({ id: "1" });
  const insertPayload = vi.fn().mockResolvedValue(undefined);
  const redact = vi.fn((x: unknown) => x);
  const record: RecordServedDeps = {
    telemetry: { insert, insertPayload } as never,
    redact: redact as never,
    now: () => 1000,
    capturePayloads: () => over.capturePayloads ?? true,
  };
  return { record, insert, insertPayload, redact };
}

const REQ = { model: "auto", input: "Say hello", max_output_tokens: 16 };

function expectNativeCarrier(
  value: unknown,
  protocol: "openai_responses",
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
  expect(carrier.headers?.authorization).toBe("Bearer helm_live_secret");
  expect(carrier.headers?.["content-type"]).toBe("application/json");
  expect(carrier.mutations).toEqual({});
}

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

  it("accepts LiteLLM-compatible create aliases", async () => {
    for (const path of ["/responses", "/openai/v1/responses"]) {
      const { deps, order } = makeDeps();
      const app = buildApp(deps);
      const res = await app.request(path, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(REQ),
      });
      expect(res.status).toBe(200);
      expect(order).toEqual(["auth", "translate-out", "route", "translate-back"]);
    }
  });

  it("authenticates Responses lifecycle endpoints before provider dispatch or local fallback", async () => {
    const lifecycle: ResponsesRouteDeps["lifecycle"] = {
      retrieve: vi.fn(),
      delete: vi.fn(),
      cancel: vi.fn(),
      inputItems: vi.fn(),
      compact: vi.fn(),
      inputTokens: vi.fn(),
    };
    const cases: Array<[string, string]> = [
      ["GET", "/v1/responses/resp_123"],
      ["DELETE", "/v1/responses/resp_123"],
      ["POST", "/v1/responses/resp_123/cancel"],
      ["GET", "/v1/responses/resp_123/input_items"],
      ["POST", "/v1/responses/compact"],
      ["POST", "/v1/responses/input_tokens"],
    ];

    for (const [method, path] of cases) {
      const { deps, order } = makeDeps({ authed: false, lifecycle });
      const app = buildApp(deps);
      const res = await app.request(path, {
        method,
        headers: method === "POST" ? AUTH : { Authorization: AUTH.Authorization },
        body: method === "POST" ? JSON.stringify(REQ) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      const body = (await res.json()) as { error: Record<string, string> };
      expect(body.error.code).toBe("invalid_api_key");
      expect(order).toEqual(["auth"]);
    }
    expect(lifecycle.retrieve).not.toHaveBeenCalled();
    expect(lifecycle.delete).not.toHaveBeenCalled();
    expect(lifecycle.cancel).not.toHaveBeenCalled();
    expect(lifecycle.inputItems).not.toHaveBeenCalled();
    expect(lifecycle.compact).not.toHaveBeenCalled();
    expect(lifecycle.inputTokens).not.toHaveBeenCalled();
  });

  it("/input_tokens calls the provider lifecycle method when it is available", async () => {
    const inputTokens = vi.fn().mockResolvedValue({ input_tokens: 123, estimated: false });
    const { deps, order } = makeDeps({ lifecycle: { inputTokens } });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/input_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 123, estimated: false });
    expect(inputTokens).toHaveBeenCalledWith(
      REQ,
      { keyId: "k1", accountId: "acct" },
      expect.any(AbortSignal),
    );
    expect(order).toEqual(["auth"]);
  });

  it("/input_tokens falls back to a deterministic local estimate when no provider method exists", async () => {
    const { deps, order } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/input_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "auto", input: "hello world", instructions: "be brief" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number; estimated: boolean };
    expect(body.input_tokens).toBeGreaterThan(1);
    expect(body.estimated).toBe(true);
    expect(order).toEqual(["auth"]);
  });

  it("/compact falls back to normal Responses routing when no provider lifecycle method exists", async () => {
    const { deps, order } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; status: string };
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(order).toEqual(["auth", "translate-out", "route", "translate-back"]);
  });

  it("calls provider-supported Responses lifecycle endpoints", async () => {
    const lifecycle: ResponsesRouteDeps["lifecycle"] = {
      retrieve: vi
        .fn()
        .mockResolvedValue({ id: "resp_123", object: "response", status: "completed" }),
      delete: vi
        .fn()
        .mockResolvedValue({ id: "resp_123", object: "response.deleted", deleted: true }),
      cancel: vi
        .fn()
        .mockResolvedValue({ id: "resp_123", object: "response", status: "cancelled" }),
      inputItems: vi.fn().mockResolvedValue({ object: "list", data: [], has_more: false }),
      compact: vi
        .fn()
        .mockResolvedValue({ id: "resp_compact", object: "response", status: "completed" }),
    };
    const { deps } = makeDeps({ lifecycle });
    const app = buildApp(deps);

    const cases: Array<[string, string, unknown]> = [
      [
        "GET",
        "/v1/responses/resp_123",
        { id: "resp_123", object: "response", status: "completed" },
      ],
      [
        "DELETE",
        "/v1/responses/resp_123",
        { id: "resp_123", object: "response.deleted", deleted: true },
      ],
      [
        "POST",
        "/v1/responses/resp_123/cancel",
        { id: "resp_123", object: "response", status: "cancelled" },
      ],
      ["GET", "/v1/responses/resp_123/input_items", { object: "list", data: [], has_more: false }],
      [
        "POST",
        "/v1/responses/compact",
        { id: "resp_compact", object: "response", status: "completed" },
      ],
    ];

    for (const [method, path, expected] of cases) {
      const res = await app.request(path, {
        method,
        headers: method === "POST" ? AUTH : { Authorization: AUTH.Authorization },
        body: method === "POST" ? JSON.stringify(REQ) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(200);
      expect(await res.json()).toEqual(expected);
    }
    expect(lifecycle.retrieve).toHaveBeenCalledWith(
      "resp_123",
      { keyId: "k1", accountId: "acct" },
      expect.any(AbortSignal),
    );
    expect(lifecycle.delete).toHaveBeenCalledWith(
      "resp_123",
      { keyId: "k1", accountId: "acct" },
      expect.any(AbortSignal),
    );
    expect(lifecycle.cancel).toHaveBeenCalledWith(
      "resp_123",
      { keyId: "k1", accountId: "acct" },
      expect.any(AbortSignal),
    );
    expect(lifecycle.inputItems).toHaveBeenCalledWith(
      "resp_123",
      { keyId: "k1", accountId: "acct" },
      expect.any(AbortSignal),
    );
    expect(lifecycle.compact).toHaveBeenCalledWith(
      REQ,
      { keyId: "k1", accountId: "acct" },
      expect.any(AbortSignal),
    );
  });

  it("records persistent Responses ids in the lifecycle registry after create", async () => {
    const put = vi.fn();
    const decision = {
      final: { status: "ok", model_alias: "responses/gpt-5.5", provider_model: "gpt-5.5" },
      provider_attempts: [
        {
          alias: "responses/gpt-5.5",
          status: "ok",
          skipped: false,
          provider_name: "openai",
          provider_model: "gpt-5.5",
          target_provider_protocol: "openai_responses",
        },
      ],
    } as never;
    const { deps } = makeDeps({
      collect: async () => ({ id: "resp_persisted", object: "response", status: "completed" }),
      run: async () => ({
        decision,
        nativePassthrough: true,
        collect: async () => ({ id: "resp_persisted", object: "response", status: "completed" }),
        streamIR: async function* () {},
      }),
      registry: { put, get: vi.fn() },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, store: true }),
    });

    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: "resp_persisted",
        accountId: "acct",
        keyId: "k1",
        providerAlias: "responses/gpt-5.5",
        providerName: "openai",
        providerModel: "gpt-5.5",
        providerProtocol: "openai_responses",
        status: "completed",
      }),
    );
  });

  it("returns an OpenAI-shaped 404 for unknown registry response ids without provider dispatch", async () => {
    const retrieve = vi.fn();
    const registry = { put: vi.fn(), get: vi.fn().mockResolvedValue(null) };
    const { deps } = makeDeps({ lifecycle: { retrieve }, registry });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/resp_missing", {
      headers: { Authorization: AUTH.Authorization },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("response_not_found");
    expect(body.error.trace_id).toBeTruthy();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("returns 404 for expired registry response ids without provider dispatch", async () => {
    const retrieve = vi.fn();
    const registryRecord = {
      responseId: "resp_expired",
      accountId: "acct",
      keyId: "k1",
      providerAlias: "responses/gpt-5.5",
      providerName: "openai",
      providerModel: "gpt-5.5",
      providerProtocol: "openai_responses" as const,
      createdAt: 1,
      expiresAt: 1,
      status: "completed",
    };
    const { deps } = makeDeps({
      lifecycle: { retrieve },
      registry: { put: vi.fn(), get: vi.fn().mockResolvedValue(registryRecord) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/resp_expired", {
      headers: { Authorization: AUTH.Authorization },
    });

    expect(res.status).toBe(404);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("passes registry records to lifecycle methods for provider-bound dispatch", async () => {
    const registryRecord = {
      responseId: "resp_123",
      accountId: "acct",
      keyId: "k1",
      providerAlias: "responses/gpt-5.5",
      providerName: "openai",
      providerModel: "gpt-5.5",
      providerProtocol: "openai_responses" as const,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      status: "completed",
    };
    const retrieve = vi
      .fn()
      .mockResolvedValue({ id: "resp_123", object: "response", status: "completed" });
    const { deps } = makeDeps({
      lifecycle: { retrieve },
      registry: { put: vi.fn(), get: vi.fn().mockResolvedValue(registryRecord) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/resp_123", {
      headers: { Authorization: AUTH.Authorization },
    });

    expect(res.status).toBe(200);
    expect(retrieve).toHaveBeenCalledWith(
      "resp_123",
      { keyId: "k1", accountId: "acct" },
      expect.any(AbortSignal),
      registryRecord,
    );
  });

  it("returns capability-shaped errors for provider-unsupported lifecycle endpoints", async () => {
    const cases: Array<[string, string]> = [
      ["GET", "/v1/responses/resp_123"],
      ["DELETE", "/v1/responses/resp_123"],
      ["POST", "/v1/responses/resp_123/cancel"],
      ["GET", "/v1/responses/resp_123/input_items"],
      ["GET", "/responses/resp_123"],
      ["DELETE", "/openai/v1/responses/resp_123"],
    ];

    for (const [method, path] of cases) {
      const { deps, order } = makeDeps();
      const app = buildApp(deps);
      const res = await app.request(path, {
        method,
        headers: method === "POST" ? AUTH : { Authorization: AUTH.Authorization },
        body: method === "POST" ? JSON.stringify(REQ) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(422);
      const body = (await res.json()) as { error: Record<string, string> };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("capability_unsatisfiable");
      expect(body.error.message).toContain("not supported");
      expect(order).toEqual(["auth"]);
    }
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

  it("returns 429 rate_limited when the concurrency gate rejects (queue full), without routing", async () => {
    const concurrencyGate = {
      acquire: async () => ({
        ok: false as const,
        reason: "queue_full" as const,
        retryAfterSeconds: 7,
      }),
    };
    const { deps, order } = makeDeps({ concurrencyGate });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
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

  it("stream:true does not duplicate the Responses prelude produced by the pipeline", async () => {
    const { deps } = makeDeps({
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      streamIR: async function* () {
        yield { type: "response.created", sequence_number: 0 };
        yield { type: "response.in_progress", sequence_number: 1 };
        yield { type: "response.completed", sequence_number: 2 };
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });

    const frames = parseSSE(await res.text());
    expect(frames.filter((f) => f.event === "response.created")).toHaveLength(1);
    expect(frames.filter((f) => f.event === "response.in_progress")).toHaveLength(1);
    expect(frames.at(-1)?.event).toBe("response.completed");
  });

  it("stream:true waits for routing before writing the first Responses SSE frame", async () => {
    let releaseRoute!: () => void;
    const routeStarted = deferred<void>();
    const routeMayFinish = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    const { deps } = makeDeps({
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      run: async () => {
        routeStarted.resolve(undefined);
        await routeMayFinish;
        return {
          decision: FAKE_DECISION,
          collect: async () => ({ id: "ir-resp", choices: [] }),
          streamIR: async function* () {
            yield { type: "response.completed", sequence_number: 2 };
          },
        };
      },
    });
    const app = buildApp(deps);

    const responsePromise = app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });

    const early = await Promise.race([responsePromise, shortTimeout()]);
    expect(early).not.toBe("timeout");
    const res = early as Response;
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const pendingFirstRead = reader?.read();
    const firstReadBeforeRoute = await Promise.race([pendingFirstRead, shortTimeout()]);
    expect(firstReadBeforeRoute).toBe("timeout");
    await routeStarted.promise;
    releaseRoute();
    const firstRead = await Promise.race([pendingFirstRead, shortTimeout()]);
    expect(firstRead).not.toBe("timeout");
    const decoder = new TextDecoder();
    const firstChunk = firstRead as { done: boolean; value?: Uint8Array };
    expect(firstChunk.done).toBe(false);
    let firstText = decoder.decode(firstChunk.value);
    while (!firstText.includes("\n\n")) {
      const next = await Promise.race([reader?.read(), shortTimeout()]);
      expect(next).not.toBe("timeout");
      const chunk = next as { done: boolean; value?: Uint8Array };
      if (chunk.done) break;
      firstText += decoder.decode(chunk.value);
    }
    expect(firstText).toContain("\n\n");
    expect(["response.created", "response.in_progress", "response.completed"]).toContain(
      parseSSE(firstText)[0]?.event,
    );
    await reader?.cancel();
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

  // ── Telemetry recording (the /admin/requests bug). /v1/responses serves LLM
  //    traffic but never recorded a telemetry row, so it was invisible in the
  //    admin Debug list. recordServed must fire on every served request.
  it("records a redacted telemetry row + payload for a served NON-STREAM request", async () => {
    const { record, insert, insertPayload, redact } = makeRecord();
    const { deps } = makeDeps({ record });
    const app = buildApp(deps);
    const rawRequest = '{\n  "model":"auto",\n  "input":"Say hello",\n  "max_output_tokens":16\n}';

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: rawRequest,
    });

    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
    const arg = insert.mock.calls[0]?.[0] as { apiKeyId: string };
    expect(arg.apiKeyId).toBe("k1");
    expect(redact).toHaveBeenCalled();
    // The plaintext bearer must never reach the persisted telemetry row.
    expect(JSON.stringify(arg)).not.toContain("helm_live_secret");
    // capture_payloads ON → the verbatim request/response body is persisted too.
    expect(insertPayload).toHaveBeenCalledOnce();
    const payload = insertPayload.mock.calls[0]?.[0] as { requestJson: string };
    expect(payload.requestJson).toBe(rawRequest);
  });

  it("records a telemetry row for a served STREAM request after the stream drains", async () => {
    const { record, insert } = makeRecord();
    const { deps } = makeDeps({
      record,
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
    // Drain the stream fully so the finally (where recording lives) runs.
    await res.text();

    expect(insert).toHaveBeenCalledOnce();
    const arg = insert.mock.calls[0]?.[0] as { apiKeyId: string };
    expect(arg.apiKeyId).toBe("k1");
  });

  it("does not record when no record dep is wired (existing tests stay green)", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(200);
  });

  // ── Capture-payloads gating (review P2). With capture_payloads OFF the route
  //    must still write the telemetry row but NOT buffer/persist the body — the
  //    stream buffer is the unbounded growth vector this gate closes.
  it("capture_payloads OFF: a served stream records the telemetry row but NOT the payload", async () => {
    const { record, insert, insertPayload } = makeRecord({ capturePayloads: false });
    const { deps } = makeDeps({
      record,
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
    await res.text();

    expect(insert).toHaveBeenCalledOnce();
    expect(insertPayload).not.toHaveBeenCalled();
  });

  // ── Terminal stream error frame must be appended to the captured body (review
  //    P2). A mid-stream upstream error writes an `event: error` frame to the
  //    client; that frame has to land in the persisted responseJson too.
  it("stream error frame is captured in the payload", async () => {
    const { record, insertPayload } = makeRecord({ capturePayloads: true });
    const { deps } = makeDeps({
      record,
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
    await res.text();

    expect(insertPayload).toHaveBeenCalledOnce();
    const arg = insertPayload.mock.calls[0]?.[0] as { responseJson: string };
    expect(arg.responseJson).toContain("event: error");
    expect(arg.responseJson).toContain("upstream exploded");
  });

  // ── Finding 3: the non-stream outbound transform must run INSIDE the failure-
  //    recording try, so a transformer throw after a provider result was collected
  //    still writes a telemetry row (consistent with messages/gemini).
  it("non-stream: an outbound transform failure still records telemetry", async () => {
    const { record, insert } = makeRecord();
    const { deps } = makeDeps({ record });
    deps.transformer.transformResponseOut = () => {
      throw new Error("transform blew up");
    };
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    // The transform throw is not a PipelineError → it escapes to onError (a 5xx).
    // The point of Finding 3 is that the telemetry row was STILL written because
    // the transform now runs inside the failure-recording try.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(insert).toHaveBeenCalledOnce();
  });

  // ── Native protocol passthrough (#217 Phase 3, Codex Responses). The route mirrors
  //    /v1/messages: stamp the verbatim inbound body onto ir.metadata.native_request
  //    (both stream + non-stream), and when the pipeline reports nativePassthrough,
  //    BYPASS transformStreamOut (stream) / transformResponseOut (non-stream) so the
  //    upstream's native Responses bytes reach the client unchanged.
  it("stamps the verbatim parsed inbound body onto ir.metadata.native_request (non-stream)", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    const meta = (harness.pipelineSawIR as { metadata?: { native_request?: unknown } } | null)
      ?.metadata;
    expectNativeCarrier(meta?.native_request, "openai_responses", REQ);
  });

  it("stamps native_request on a STREAMING request too (Codex is stream-only)", async () => {
    const { deps, harness } = makeDeps({
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
    await res.text();

    const meta = (harness.pipelineSawIR as { metadata?: { native_request?: unknown } } | null)
      ?.metadata;
    expectNativeCarrier(meta?.native_request, "openai_responses", { ...REQ, stream: true });
  });

  it("non-stream passthrough: returns the verbatim native Responses body, skipping translate-back", async () => {
    const upstreamNative = {
      id: "resp_passthrough_1",
      object: "response",
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "verbatim" }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 4 },
    };
    const { deps, order } = makeDeps({
      nativePassthrough: true,
      collect: async () => upstreamNative,
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // BYTE-EQUALITY: the client gets the exact native upstream body — no translate-back
    // wrapper, no __ir marker the stub responseOut adds.
    expect(body).toEqual(upstreamNative);
    expect((body as { __ir?: unknown }).__ir).toBeUndefined();
    expect(order).toEqual(["auth", "translate-out", "route"]);
    expect(order).not.toContain("translate-back");
  });

  it("stream passthrough: writes the VERBATIM upstream frames byte-for-byte (no transformStreamOut)", async () => {
    // Non-canonical spacing inside the data payload proves the route forwards the
    // {event,data} item directly instead of re-shaping it via transformStreamOut.
    const deltaData = '{"type":"response.output_text.delta","delta":"hi"}';
    const completedData =
      '{"type":"response.completed","response":{"status":"completed","usage":{ "input_tokens":5 ,"output_tokens":4}}}';
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "response.created", data: '{"type":"response.created"}' };
      yield { event: "response.output_text.delta", data: deltaData };
      yield { event: "response.completed", data: completedData };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      streamIR: events,
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // The verbatim data payloads (with their non-canonical spacing) reach the wire —
    // NOT the stub transformStreamOut shape (which would JSON.stringify the bag).
    expect(text).toContain(`event: response.output_text.delta\ndata: ${deltaData}`);
    expect(text).toContain(`event: response.completed\ndata: ${completedData}`);
    const frames = parseSSE(text);
    // Exactly ONE response.created: the upstream's own native prelude. The route
    // must not synthesize, drop, or rewrite it on the passthrough path.
    expect(frames.filter((f) => f.event === "response.created")).toHaveLength(1);
    const created = frames.find((f) => f.event === "response.created");
    expect(created?.data).toBe('{"type":"response.created"}');
  });

  it("stream passthrough: preserves upstream response.id without a synthetic prelude", async () => {
    // Native passthrough keeps the upstream Responses stream authoritative: no route
    // prelude and no response.id rewrite.
    const put = vi.fn();
    const completedData = JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_upstream_xyz",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 4 },
      },
    });
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "response.completed", data: completedData };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      streamIR: events,
      registry: { put, get: vi.fn() },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });

    const frames = parseSSE(await res.text());
    const completedId = (
      JSON.parse(frames.find((f) => f.event === "response.completed")?.data ?? "{}") as {
        response?: { id?: string };
      }
    ).response?.id;
    expect(frames.some((f) => f.event === "response.created")).toBe(false);
    expect(completedId).toBe("resp_upstream_xyz");
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: "resp_upstream_xyz",
        accountId: "acct",
        keyId: "k1",
        status: "completed",
      }),
    );
  });

  it("stream NON-passthrough (default): still maps via transformStreamOut as today", async () => {
    async function* events() {
      yield { type: "response.created", sequence_number: 0 };
      yield { type: "response.output_text.delta", delta: "hi", sequence_number: 1 };
      yield { type: "response.completed", sequence_number: 2 };
    }
    const { deps } = makeDeps({
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      streamIR: events,
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    const text = await res.text();
    // The stub transformStreamOut maps {type} → {event:type, data:JSON.stringify(ev)},
    // so the delta frame's data is the re-serialized IR event bag (translate path).
    const frames = parseSSE(text);
    const delta = frames.find((f) => f.event === "response.output_text.delta");
    expect(JSON.parse(delta?.data ?? "{}")).toMatchObject({
      type: "response.output_text.delta",
      delta: "hi",
    });
  });
});
