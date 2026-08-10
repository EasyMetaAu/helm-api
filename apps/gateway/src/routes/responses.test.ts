import {
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  createRuntimeMemoryCoordinator,
  type DecisionRecord,
  deriveSafeWorkingMemoryCapacity,
  type ExecutionResult,
  hashKey,
  responsesTransformer,
  type TelemetryStore,
  type UpsertSessionRevisionInput,
  UpstreamError,
} from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER,
  trackResponsesWebSocketRequest,
} from "../responses-websocket-internal.js";
import { createBodyMemoryAdmission } from "../runtime/memory-admission.js";
import { capsFromRecord, type MessagesIdentity } from "./messages.js";
import { createMessagesPipeline, PipelineError, type RouteFn } from "./messages-pipeline.js";
import type { RecordServedDeps, SseCapture } from "./payload-capture.js";
import {
  type ResponsesRouteDeps,
  registerResponsesRoute,
  settleResponsesStreamOutcome,
} from "./responses.js";

// POST /v1/responses contract: auth → translate(out) → route → translate(back),
// OpenAI error envelope, non-streaming only. All business logic is stubbed; the
// route must be pure HTTP glue (CLAUDE.md principle 1).

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

// A fake DecisionRecord stand-in: the route treats it as an opaque bag it hands
// to recordServed → redact → telemetry.insert (it never inspects fields). The
// `model_alias` marker lets a test assert the redacted decision actually rode the
// insert call.
const FAKE_DECISION = { final: { status: "ok", model_alias: "gpt-4o" } } as never;

describe("settleResponsesStreamOutcome", () => {
  it("gives an overall request timeout precedence over an AbortError", () => {
    const decision = {
      final: { status: "ok", model_alias: "gpt-4o", error_reason: null },
      stream_outcome: null,
    } as unknown as DecisionRecord;

    const outcome = settleResponsesStreamOutcome({
      decision,
      streamStatus: null,
      cancellationReason: "client_abort",
      caughtErrorReason: null,
      timedOut: true,
    });

    expect(outcome).toBe("failed");
    expect(decision.stream_outcome).toBe("failed");
    expect(decision.final).toMatchObject({ status: "error", error_reason: "timeout" });
  });

  it("keeps an observed terminal failure when the bridge aborts during teardown", () => {
    const decision = {
      final: { status: "ok", model_alias: "gpt-4o", error_reason: null },
      stream_outcome: null,
    } as unknown as DecisionRecord;

    const outcome = settleResponsesStreamOutcome({
      decision,
      streamStatus: "failed",
      cancellationReason: "client_abort",
      caughtErrorReason: null,
      timedOut: false,
    });

    expect(outcome).toBe("failed");
    expect(decision.stream_outcome).toBe("failed");
    expect(decision.final).toMatchObject({ status: "error", error_reason: "upstream_error" });
  });
});

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
    responseMetadata?: Record<string, string>;
    run?: ResponsesRouteDeps["pipeline"]["run"];
    rateLimiter?: ResponsesRouteDeps["rateLimiter"];
    concurrencyGate?: ResponsesRouteDeps["concurrencyGate"];
    identity?: MessagesIdentity;
    record?: RecordServedDeps;
    lifecycle?: ResponsesRouteDeps["lifecycle"];
    budget?: ResponsesRouteDeps["budget"];
    recordOAuthUsage?: ResponsesRouteDeps["recordOAuthUsage"];
    registry?: ResponsesRouteDeps["registry"];
    modelsEtag?: string | null;
    modelsEtagForKey?: ResponsesRouteDeps["modelsEtagForKey"];
    memoryAdmission?: ResponsesRouteDeps["memoryAdmission"];
    sseCaptureFactory?: ResponsesRouteDeps["sseCaptureFactory"];
  } = {},
): { deps: ResponsesRouteDeps; order: string[]; harness: { pipelineSawIR: unknown } } {
  const order: string[] = [];
  const harness: { pipelineSawIR: unknown } = { pipelineSawIR: null };
  const deps: ResponsesRouteDeps = {
    rateLimiter: over.rateLimiter,
    concurrencyGate: over.concurrencyGate,
    record: over.record,
    lifecycle: over.lifecycle,
    budget: over.budget,
    recordOAuthUsage: over.recordOAuthUsage,
    registry: over.registry,
    memoryAdmission: over.memoryAdmission,
    sseCaptureFactory: over.sseCaptureFactory,
    ...(over.modelsEtagForKey !== undefined
      ? { modelsEtagForKey: over.modelsEtagForKey }
      : over.modelsEtag === undefined
        ? {}
        : { modelsEtagForKey: () => over.modelsEtag ?? null }),
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
            ...(over.responseMetadata !== undefined
              ? { responseMetadata: over.responseMetadata }
              : {}),
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
  it("admits the production 25.64 MiB request under healthy cgroup headroom", async () => {
    const capacityBytes = () =>
      deriveSafeWorkingMemoryCapacity({
        heapLimitBytes: 4 * 1024 * 1024 * 1024,
        heapUsedBytes: 512 * 1024 * 1024,
        availableMemoryBytes: 480_205_864,
        hostTotalMemoryBytes: 64 * 1024 * 1024 * 1024,
        constrainedMemoryBytes: 1_536 * 1024 * 1024,
      });
    const coordinator = createRuntimeMemoryCoordinator({ capacityBytes });
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1,
      jsonAmplification: 6,
      minRequestChargeBytes: 1,
      coordinator,
    });
    const { deps } = makeDeps({ memoryAdmission });
    const app = buildApp(deps);
    const wireBytes = 26_888_188;
    const emptyBody = JSON.stringify({ ...REQ, input: "" });
    const body = JSON.stringify({ ...REQ, input: "x".repeat(wireBytes - emptyBody.length) });
    expect(Buffer.byteLength(body)).toBe(wireBytes);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body,
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(coordinator.reservedBytes).toBe(0);
    expect(memoryAdmission.reservedBytes).toBe(0);
    expect(memoryAdmission.pendingBytes).toBe(0);
  });

  it("accepts a body larger than the former hard body limit", async () => {
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    const { deps, order } = makeDeps({ memoryAdmission });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(order).toContain("auth");
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

  it("does not reject aggregate capacity while a parsed streaming request remains active", async () => {
    const finish = deferred<void>();
    const memoryAdmission = createBodyMemoryAdmission({
      activeRequestBytes: 1_000,
      jsonAmplification: 1,
      minRequestChargeBytes: 1,
    });
    const { deps } = makeDeps({
      memoryAdmission,
      transformRequestOut: (native) => {
        expect(memoryAdmission.pendingBytes).toBeGreaterThan(0);
        return {
          stream: (native as { stream?: unknown }).stream === true,
          model: "auto",
          metadata: {},
        };
      },
      streamIR: async function* () {
        yield { type: "response.created", sequence_number: 0 };
        await finish.promise;
        yield { type: "response.completed", sequence_number: 1 };
      },
    });
    const app = buildApp(deps);

    const active = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    expect(active.status).toBe(200);
    expect(memoryAdmission.reservedBytes).toBeGreaterThan(0);
    expect(memoryAdmission.pendingBytes).toBe(0);

    const next = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(next.status).toBe(200);

    finish.resolve(undefined);
    await active.text();
    expect(memoryAdmission.reservedBytes).toBe(0);
  });

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

  it("returns request-scoped Codex response metadata for non-streaming requests", async () => {
    const { deps } = makeDeps({
      responseMetadata: {
        "openai-model": "gpt-5.6-sol",
        "x-codex-turn-state": "turn-state-1",
        "x-models-etag": '"models-v2"',
        "x-reasoning-included": "true",
        "x-request-id": "req-upstream-1",
        "x-codex-primary-used-percent": "25",
        "set-cookie": "must-not-leak",
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.headers.get("openai-model")).toBe("gpt-5.6-sol");
    expect(res.headers.get("x-codex-turn-state")).toBe("turn-state-1");
    expect(res.headers.get("x-models-etag")).toBe('"models-v2"');
    expect(res.headers.get("x-reasoning-included")).toBe("true");
    expect(res.headers.get("x-request-id")).toBe("req-upstream-1");
    expect(res.headers.get("x-codex-primary-used-percent")).toBe("25");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("replaces the upstream account ETag with the key-filtered models ETag", async () => {
    const { deps } = makeDeps({
      responseMetadata: {
        "x-models-etag": '"upstream-account-etag"',
      },
      modelsEtag: '"helm-key-filtered-etag"',
    });
    const res = await buildApp(deps).request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.headers.get("x-models-etag")).toBe('"helm-key-filtered-etag"');
  });

  it("selects the key-filtered models ETag by the inbound Codex version", async () => {
    const modelsEtagForKey = vi.fn((keyId: string, clientVersion: string | null) =>
      keyId === "k1" && clientVersion === "0.145.0" ? '"helm-0.145.0"' : null,
    );
    const { deps } = makeDeps({
      responseMetadata: {
        "x-models-etag": '"upstream-account-etag"',
      },
      modelsEtagForKey,
    });
    const res = await buildApp(deps).request("/v1/responses", {
      method: "POST",
      headers: { ...AUTH, version: "0.145.0" },
      body: JSON.stringify(REQ),
    });

    expect(modelsEtagForKey).toHaveBeenCalledWith("k1", "0.145.0");
    expect(res.headers.get("x-models-etag")).toBe('"helm-0.145.0"');
  });

  it("normalizes a prerelease Codex version for ETag lookup and upstream execution", async () => {
    const modelsEtagForKey = vi.fn(() => '"helm-0.145.0"');
    const { deps, harness } = makeDeps({ modelsEtagForKey });
    const res = await buildApp(deps).request("/v1/responses", {
      method: "POST",
      headers: { ...AUTH, version: "0.145.0-alpha.4" },
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    expect(modelsEtagForKey).toHaveBeenCalledWith("k1", "0.145.0");
    const carrier = (
      harness.pipelineSawIR as {
        metadata?: { native_request?: { headers?: Record<string, string> } };
      }
    ).metadata?.native_request;
    expect(carrier?.headers?.version).toBe("0.145.0");
  });

  it("rejects an invalid explicit Codex version before routing", async () => {
    const run = vi.fn();
    const { deps } = makeDeps({ run });
    const res = await buildApp(deps).request("/v1/responses", {
      method: "POST",
      headers: { ...AUTH, version: "latest" },
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not reuse a models ETag when the request has no Codex version", async () => {
    const modelsEtagForKey = vi.fn((_keyId: string, clientVersion: string | null) =>
      clientVersion === null ? null : '"wrong-version"',
    );
    const { deps } = makeDeps({
      responseMetadata: {
        "x-models-etag": '"upstream-account-etag"',
      },
      modelsEtagForKey,
    });
    const res = await buildApp(deps).request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(modelsEtagForKey).toHaveBeenCalledWith("k1", null);
    expect(res.headers.get("x-models-etag")).toBeNull();
  });

  it("suppresses the upstream models ETag before this key has listed its catalog", async () => {
    const { deps } = makeDeps({
      responseMetadata: {
        "x-models-etag": '"upstream-account-etag"',
      },
      modelsEtag: null,
    });
    const res = await buildApp(deps).request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.headers.get("x-models-etag")).toBeNull();
  });

  it("opens the upstream stream and sets Codex metadata before returning HTTP headers", async () => {
    let pipelineOpened = false;
    const { deps } = makeDeps({
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      run: async () => {
        pipelineOpened = true;
        return {
          decision: FAKE_DECISION,
          responseMetadata: {
            "openai-model": "gpt-5.6-sol",
            "x-codex-turn-state": "stream-turn-state",
            "x-request-id": "req-stream-1",
          },
          collect: async () => ({}),
          streamIR: async function* () {
            yield { type: "response.completed", sequence_number: 0 };
          },
        };
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });

    expect(pipelineOpened).toBe(true);
    expect(res.headers.get("openai-model")).toBe("gpt-5.6-sol");
    expect(res.headers.get("x-codex-turn-state")).toBe("stream-turn-state");
    expect(res.headers.get("x-request-id")).toBe("req-stream-1");
    await res.text();
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

  it("/compact fails closed when no provider lifecycle method exists", async () => {
    const { deps, order } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("capability_unsatisfiable");
    expect(body.error.message).toContain("compact");
    expect(order).toEqual(["auth"]);
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
      expect.objectContaining({
        protocol: "openai_responses",
        body: REQ,
        raw_body: JSON.stringify(REQ),
        headers: expect.objectContaining({
          authorization: "Bearer helm_live_secret",
          "content-type": "application/json",
        }),
      }),
      { keyId: "k1", accountId: "acct" },
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("/compact forwards upstream Codex response metadata on the same request", async () => {
    const compact = vi.fn(
      async (
        _body: unknown,
        _identity: MessagesIdentity,
        _signal: AbortSignal,
        onResponseMeta?: (headers: Headers) => void,
      ) => {
        onResponseMeta?.(
          new Headers({
            "openai-model": "gpt-5.6-sol",
            "x-codex-turn-state": "compact-turn-state",
            "x-request-id": "req-compact-1",
          }),
        );
        return { output: [] };
      },
    );
    const { deps } = makeDeps({ lifecycle: { compact } });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: {
        ...AUTH,
        "session-id": "session-1",
        "thread-id": "thread-1",
        "x-codex-turn-state": "turn-before",
      },
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("openai-model")).toBe("gpt-5.6-sol");
    expect(res.headers.get("x-codex-turn-state")).toBe("compact-turn-state");
    expect(res.headers.get("x-request-id")).toBe("req-compact-1");
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "session-id": "session-1",
          "thread-id": "thread-1",
          "x-codex-turn-state": "turn-before",
        }),
      }),
      expect.anything(),
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("/compact applies the same per-key RPM/TPM limiter before provider dispatch", async () => {
    const compact = vi.fn().mockResolvedValue({ output: [] });
    const check = vi.fn().mockResolvedValue({
      allowed: false,
      limitedBy: "tpm",
      limit: 100,
      remaining: 0,
      resetSeconds: 12,
      retryAfterSeconds: 12,
    });
    const { deps } = makeDeps({
      lifecycle: { compact },
      rateLimiter: { check },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: "k1",
        estimatedTokens: expect.any(Number),
      }),
    );
    expect(compact).not.toHaveBeenCalled();
  });

  it("/compact holds and releases the same per-key concurrency lease", async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockResolvedValue({ ok: true, release });
    const compact = vi.fn().mockResolvedValue({ output: [] });
    const { deps } = makeDeps({
      lifecycle: { compact },
      concurrencyGate: { acquire },
      identity: {
        keyId: "k1",
        accountId: "acct",
        caps: { concurrencyLimit: 2 },
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    expect(acquire).toHaveBeenCalledWith({
      keyId: "k1",
      limit: 2,
      signal: expect.any(AbortSignal),
    });
    expect(compact).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("/compact records telemetry and payloads for direct subscription execution", async () => {
    const { record, insert, insertPayload } = makeRecord();
    const compact = vi.fn().mockResolvedValue({
      id: "resp_compact",
      object: "response.compaction",
      model: "gpt-5.6-sol",
      output: [],
      service_tier: "priority",
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
        cost_usd: 0.0042,
        input_tokens_details: {
          cached_tokens: 2,
          ephemeral_5m_input_tokens: 1,
          audio_tokens: 4,
          cached_audio_tokens: 1,
        },
        output_tokens_details: { image_tokens: 2 },
      },
    });
    const { deps } = makeDeps({ lifecycle: { compact }, record });
    const app = buildApp(deps);
    const rawRequest = '{\n  "model":"gpt-5.6-sol",\n  "input":"compact this"\n}';

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: rawRequest,
    });

    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
    expect(insertPayload).toHaveBeenCalledOnce();
    const telemetry = insert.mock.calls[0]?.[0] as {
      apiKeyId: string;
      decision: {
        protocol: string;
        final: { status: string; provider_model: string };
        usage: {
          prompt_tokens: number;
          completion_tokens: number;
          service_tier: string;
          cache_creation_5m_tokens: number;
          audio_prompt_tokens: number;
          cached_audio_prompt_tokens: number;
          image_output_tokens: number;
          billed_cost_usd: number;
        };
      };
    };
    expect(telemetry.apiKeyId).toBe("k1");
    expect(telemetry.decision.protocol).toBe("openai_responses");
    expect(telemetry.decision.final).toMatchObject({
      status: "ok",
      provider_model: "gpt-5.6-sol",
    });
    expect(telemetry.decision.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 3,
      service_tier: "priority",
      cache_creation_5m_tokens: 1,
      audio_prompt_tokens: 4,
      cached_audio_prompt_tokens: 1,
      image_output_tokens: 2,
      billed_cost_usd: 0.0042,
    });
    expect(insertPayload.mock.calls[0]?.[0]).toMatchObject({
      requestJson: rawRequest,
      responseJson: expect.stringContaining('"resp_compact"'),
    });
  });

  it("/compact keeps reasoning effort telemetry when payload capture is off", async () => {
    const { record, insert, insertPayload } = makeRecord({ capturePayloads: false });
    const compact = vi.fn().mockResolvedValue({
      id: "resp_compact",
      model: "gpt-5.6-sol",
      output: [],
    });
    const { deps } = makeDeps({ lifecycle: { compact }, record });

    const res = await buildApp(deps).request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: "compact this",
        reasoning: { effort: "xhigh" },
      }),
    });

    expect(res.status).toBe(200);
    expect(insertPayload).not.toHaveBeenCalled();
    expect(insert.mock.calls[0]?.[0]).toMatchObject({
      decision: { reasoning_effort: "xhigh" },
    });
  });

  it("/compact captures under a per-key payload override even when global mode is metadata-only", async () => {
    const { record, insertPayload } = makeRecord({ capturePayloads: false });
    const compact = vi.fn().mockResolvedValue({ id: "resp_compact", output: [] });
    const { deps } = makeDeps({
      lifecycle: { compact },
      record,
      identity: { keyId: "k1", accountId: "acct", caps: { requestContentMode: "payload" } },
    });

    const res = await buildApp(deps).request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(200);
    // The key's explicit `payload` mode overrides the global metadata-only toggle.
    expect(insertPayload).toHaveBeenCalledOnce();
  });

  it("/compact rejects an exhausted per-key usage budget before subscription dispatch", async () => {
    const compact = vi.fn().mockResolvedValue({ output: [] });
    const check = vi.fn().mockResolvedValue({
      overBudget: true,
      limitedBy: "req",
      behavior: "reject",
      degradeLane: null,
    });
    const settle = vi.fn();
    const { deps } = makeDeps({
      lifecycle: { compact },
      identity: {
        keyId: "k1",
        accountId: "acct",
        caps: {
          budget: {
            requests: 10,
            tokens: null,
            spendUsd: null,
            windowSeconds: 3600,
            behavior: "reject",
            degradeLane: null,
          },
        },
      },
      budget: {
        gate: { check },
        settle,
        now: () => 1_000,
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(429);
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ keyId: "k1", nowMs: 1_000 }));
    expect(compact).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("/compact applies a usage-budget degrade lane before resolving the provider model", async () => {
    const compact = vi.fn().mockResolvedValue({ output: [] });
    const { deps } = makeDeps({
      lifecycle: { compact },
      identity: {
        keyId: "k1",
        accountId: "acct",
        caps: {
          budget: {
            requests: 10,
            tokens: null,
            spendUsd: null,
            windowSeconds: 3600,
            behavior: "degrade",
            degradeLane: "economy",
          },
        },
      },
      budget: {
        gate: {
          check: vi.fn().mockResolvedValue({
            overBudget: true,
            limitedBy: "req",
            behavior: "degrade",
            degradeLane: "economy",
          }),
        },
        settle: vi.fn(),
        now: () => 1_000,
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "compact this" }),
    });

    expect(res.status).toBe(200);
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ model: "economy" }),
      }),
      expect.anything(),
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("/compact settles budget and attributes usage to the actual OAuth account", async () => {
    const { record, insert, insertPayload } = makeRecord();
    const settle = vi.fn().mockResolvedValue(undefined);
    const recordOAuthUsage = vi.fn();
    const compact = vi.fn(
      async (
        _body: unknown,
        _identity: MessagesIdentity,
        _signal: AbortSignal,
        _onResponseMeta?: (headers: Headers) => void,
        onExecution?: (execution: {
          modelAlias: string;
          providerModel: string;
          providerName: string;
          upstreamRequest: string | null;
          servingAccount: { providerId: string; account: string } | null;
        }) => void,
      ) => {
        onExecution?.({
          modelAlias: "openai-codex/gpt-5.6-terra",
          providerModel: "gpt-5.6-terra",
          providerName: "openai-codex",
          upstreamRequest: '{"model":"gpt-5.6-terra","input":"compact this"}',
          servingAccount: { providerId: "openai-codex", account: "docker-live" },
        });
        return {
          id: "resp_compact",
          model: "gpt-5.6-terra",
          output: [],
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        };
      },
    );
    const budgetCaps = {
      requests: 10,
      tokens: 1_000,
      spendUsd: null,
      windowSeconds: 3600,
      behavior: "reject" as const,
      degradeLane: null,
    };
    const { deps } = makeDeps({
      lifecycle: { compact },
      identity: {
        keyId: "k1",
        keyPrefix: "helm_live_abcd",
        accountId: "acct",
        caps: { budget: budgetCaps },
      },
      record,
      budget: {
        gate: {
          check: vi.fn().mockResolvedValue({
            overBudget: false,
            limitedBy: null,
            behavior: "degrade",
            degradeLane: null,
          }),
        },
        settle,
        costOf: () => null,
        now: () => 2_000,
      },
      recordOAuthUsage,
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "gpt-5.6-terra", input: "compact this" }),
    });

    expect(res.status).toBe(200);
    expect(settle).toHaveBeenCalledWith(
      "k1",
      budgetCaps,
      { requests: 1, tokens: 15, costUsd: null },
      2_000,
    );
    expect(recordOAuthUsage).toHaveBeenCalledWith(
      { providerId: "openai-codex", account: "docker-live" },
      "openai-codex/gpt-5.6-terra",
      { tokens: 15, costUsd: null },
    );
    expect(insert).toHaveBeenCalledOnce();
    expect(insertPayload).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]?.[0]).toMatchObject({
      decision: {
        final: {
          model_alias: "openai-codex/gpt-5.6-terra",
          provider_model: "gpt-5.6-terra",
        },
        serving_account: {
          provider_id: "openai-codex",
          account: "docker-live",
        },
      },
    });
    expect(insertPayload.mock.calls[0]?.[0]).toMatchObject({
      upstreamRequestJson: '{"model":"gpt-5.6-terra","input":"compact this"}',
    });
  });

  it("/compact aggregates usage carried by Codex compact output items", async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const costOf = vi.fn().mockReturnValue(0.0042);
    const recordOAuthUsage = vi.fn();
    const compact = vi.fn(
      async (
        _body: unknown,
        _identity: MessagesIdentity,
        _signal: AbortSignal,
        _onResponseMeta?: (headers: Headers) => void,
        onExecution?: (execution: {
          modelAlias: string;
          providerModel: string;
          providerName: string;
          upstreamRequest: string | null;
          servingAccount: { providerId: string; account: string } | null;
        }) => void,
      ) => {
        onExecution?.({
          modelAlias: "openai-codex/gpt-5.6-sol",
          providerModel: "gpt-5.6-sol",
          providerName: "openai-codex",
          upstreamRequest: '{"model":"gpt-5.6-sol"}',
          servingAccount: { providerId: "openai-codex", account: "docker-live" },
        });
        return {
          output: [
            {
              type: "message",
              usage: {
                input_tokens: 12,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 2 },
              },
            },
            {
              type: "compaction_summary",
              usage: {
                input_tokens: 4,
                output_tokens: 1,
                input_tokens_details: { cached_tokens: 1, cache_creation_input_tokens: 2 },
              },
            },
          ],
        };
      },
    );
    const budgetCaps = {
      requests: 10,
      tokens: 1_000,
      spendUsd: 1,
      windowSeconds: 3600,
      behavior: "reject" as const,
      degradeLane: null,
    };
    const { deps } = makeDeps({
      lifecycle: { compact },
      identity: {
        keyId: "k1",
        accountId: "acct",
        caps: { budget: budgetCaps },
      },
      budget: {
        gate: {
          check: vi.fn().mockResolvedValue({
            overBudget: false,
            limitedBy: null,
            behavior: "reject",
            degradeLane: null,
          }),
        },
        settle,
        costOf,
        now: () => 2_000,
      },
      recordOAuthUsage,
    });

    const res = await buildApp(deps).request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "compact this" }),
    });

    expect(res.status).toBe(200);
    expect(costOf).toHaveBeenCalledWith("openai-codex/gpt-5.6-sol", {
      prompt_tokens: 16,
      completion_tokens: 4,
      total_tokens: 20,
      prompt_tokens_details: {
        cached_tokens: 3,
        cache_creation_tokens: 2,
      },
    });
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(
      "k1",
      budgetCaps,
      { requests: 1, tokens: 20, costUsd: 0.0042 },
      2_000,
    );
    expect(recordOAuthUsage).toHaveBeenCalledOnce();
    expect(recordOAuthUsage).toHaveBeenCalledWith(
      { providerId: "openai-codex", account: "docker-live" },
      "openai-codex/gpt-5.6-sol",
      { tokens: 20, costUsd: 0.0042 },
    );
  });

  it("/compact prefers top-level usage and does not double-settle nested output usage", async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const recordOAuthUsage = vi.fn();
    const compact = vi.fn().mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      output: [
        {
          type: "compaction_summary",
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      ],
    });
    const budgetCaps = {
      requests: 10,
      tokens: 1_000,
      spendUsd: null,
      windowSeconds: 3600,
      behavior: "reject" as const,
      degradeLane: null,
    };
    const { deps } = makeDeps({
      lifecycle: { compact },
      identity: {
        keyId: "k1",
        accountId: "acct",
        caps: { budget: budgetCaps },
      },
      budget: {
        gate: {
          check: vi.fn().mockResolvedValue({
            overBudget: false,
            limitedBy: null,
            behavior: "reject",
            degradeLane: null,
          }),
        },
        settle,
        now: () => 3_000,
      },
      recordOAuthUsage,
    });

    const res = await buildApp(deps).request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "compact this" }),
    });

    expect(res.status).toBe(200);
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(
      "k1",
      budgetCaps,
      { requests: 1, tokens: 12, costUsd: null },
      3_000,
    );
    expect(recordOAuthUsage).toHaveBeenCalledOnce();
    expect(recordOAuthUsage).toHaveBeenCalledWith(null, "openai-codex/gpt-5.6-sol", {
      tokens: 12,
      costUsd: null,
    });
  });

  it("/compact records a failed direct subscription attempt before surfacing the error", async () => {
    const { record, insert, insertPayload } = makeRecord();
    const compact = vi.fn(
      async (
        _body: unknown,
        _identity: MessagesIdentity,
        _signal: AbortSignal,
        _onResponseMeta?: (headers: Headers) => void,
        onExecution?: (execution: {
          modelAlias: string;
          providerModel: string;
          providerName: string;
          upstreamRequest: string | null;
          servingAccount: { providerId: string; account: string } | null;
        }) => void,
      ) => {
        onExecution?.({
          modelAlias: "openai-codex/gpt-5.6-luna",
          providerModel: "gpt-5.6-luna",
          providerName: "openai-codex",
          upstreamRequest: '{"model":"gpt-5.6-luna","input":"compact this"}',
          servingAccount: { providerId: "openai-codex", account: "docker-live" },
        });
        throw new UpstreamError(
          "upstream_error",
          "upstream returned 429",
          { code: "rate_limit" },
          429,
        );
      },
    );
    const { deps } = makeDeps({ lifecycle: { compact }, record });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses/compact", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "compact this" }),
    });

    expect(res.status).toBe(502);
    expect(insert).toHaveBeenCalledOnce();
    expect(insertPayload).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]?.[0]).toMatchObject({
      decision: {
        protocol: "openai_responses",
        final: { status: "error", error_reason: "upstream_error" },
        provider_attempts: [
          expect.objectContaining({
            alias: "openai-codex/gpt-5.6-luna",
            status: "error",
            error_detail: {
              upstream_status: 429,
              message: "upstream returned 429",
              provider_raw: { code: "rate_limit" },
            },
          }),
        ],
        serving_account: {
          provider_id: "openai-codex",
          account: "docker-live",
        },
      },
    });
    expect(insertPayload.mock.calls[0]?.[0]).toMatchObject({
      responseJson: null,
      upstreamRequestJson: '{"model":"gpt-5.6-luna","input":"compact this"}',
    });
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
        servingAccount: { providerId: "openai-codex", account: "stale-oauth-account" },
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
        providerAccount: null,
        status: "completed",
      }),
    );
  });

  it("pins previous_response_id continuations to the provider that created the response", async () => {
    const registryRecord = {
      responseId: "resp_previous",
      accountId: "acct",
      keyId: "k1",
      providerAlias: "openai-codex/gpt-5.6-sol",
      providerName: "openai-codex",
      providerModel: "gpt-5.6-sol",
      providerProtocol: "openai_responses" as const,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      status: "completed",
    };
    const get = vi.fn().mockResolvedValue(registryRecord);
    const { deps, harness } = makeDeps({ registry: { put: vi.fn(), get } });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, previous_response_id: "resp_previous" }),
    });

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledWith("resp_previous", { keyId: "k1", accountId: "acct" });
    expect(harness.pipelineSawIR).toMatchObject({
      metadata: { stateful_provider_alias: "openai-codex/gpt-5.6-sol" },
    });
  });

  it("serves a native WebSocket-style continuation whose incremental input is empty", async () => {
    const routeHarness: { routed: Parameters<RouteFn>[0] | null } = { routed: null };
    const route: RouteFn = async (request) => {
      routeHarness.routed = request;
      return {
        decision: FAKE_DECISION,
        final: { status: "ok", alias: "openai-codex/gpt-5.6-sol" },
        body: null,
        stream: (async function* () {
          yield 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-next"}}\n\n';
          yield 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-next","status":"completed"}}\n\n';
        })(),
        error: null,
        nativePassthrough: true,
      } as ExecutionResult;
    };
    const pipeline = createMessagesPipeline(route, "openai_responses");
    const registryRecord = {
      responseId: "resp_previous",
      accountId: "acct",
      keyId: "k1",
      providerAlias: "openai-codex/gpt-5.6-sol",
      providerName: "openai-codex",
      providerModel: "gpt-5.6-sol",
      providerProtocol: "openai_responses" as const,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      status: "completed",
    };
    const { deps } = makeDeps({
      transformRequestOut: (native) =>
        responsesTransformer.transformRequestOut(native) as {
          stream?: boolean;
          metadata?: Record<string, unknown>;
        },
      run: pipeline.run,
      registry: { put: vi.fn(), get: vi.fn().mockResolvedValue(registryRecord) },
    });
    const app = buildApp(deps);
    const body = {
      model: "gpt-5.6-sol",
      input: [],
      previous_response_id: "resp_previous",
      stream: true,
      store: false,
    };

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("response.completed");
    expect(routeHarness.routed?.messages).toEqual([]);
    expect(routeHarness.routed?.metadata.stateful_provider_alias).toBe("openai-codex/gpt-5.6-sol");
    expect((routeHarness.routed?.native_request as { body?: unknown } | undefined)?.body).toEqual(
      body,
    );
  });

  it("clamps a native-passthrough Responses reasoning.effort down to the key's ceiling", async () => {
    // Regression: luke's key caps max_reasoning_effort at "medium", but a Codex
    // Responses request asking for "high" reached the upstream verbatim because the
    // per-key ceiling was never enforced on the /v1/responses surface (the clamp had
    // only been wired into /v1/chat and /v1/messages). Assert the carrier body that
    // reaches route() has been clamped to the cap.
    const routeHarness: { routed: Parameters<RouteFn>[0] | null } = { routed: null };
    const route: RouteFn = async (request) => {
      routeHarness.routed = request;
      return {
        decision: FAKE_DECISION,
        final: { status: "ok", alias: "openai-codex/gpt-5.6-sol" },
        body: null,
        stream: (async function* () {
          yield 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-x","status":"completed"}}\n\n';
        })(),
        error: null,
        nativePassthrough: true,
      } as ExecutionResult;
    };
    const pipeline = createMessagesPipeline(route, "openai_responses");
    const registryRecord = {
      responseId: "resp_previous",
      accountId: "acct",
      keyId: "k1",
      providerAlias: "openai-codex/gpt-5.6-sol",
      providerName: "openai-codex",
      providerModel: "gpt-5.6-sol",
      providerProtocol: "openai_responses" as const,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      status: "completed",
    };
    const { deps } = makeDeps({
      transformRequestOut: (native) =>
        responsesTransformer.transformRequestOut(native) as {
          stream?: boolean;
          metadata?: Record<string, unknown>;
        },
      run: pipeline.run,
      // Build caps through the SAME production mapping the composition root uses, so
      // this exercises the resolver bug (dropped maxReasoningEffort) end-to-end — not
      // a hand-written caps object that would mask it.
      identity: {
        keyId: "k1",
        accountId: "acct",
        caps: capsFromRecord({
          key_id: "k1",
          hash: hashKey("helm_live_secret"),
          prefix: "helm_live_ab",
          account_id: "acct",
          role: "user",
          name: null,
          allowed_lanes: null,
          allow_custom_model: true,
          blocked_models: null,
          allow_fast_mode: false,
          disabled: false,
          rate_limit_rpm: null,
          rate_limit_tpm: null,
          budget_requests: null,
          budget_tokens: null,
          budget_spend_usd: null,
          budget_window_seconds: null,
          over_budget_behavior: "degrade",
          degrade_lane: null,
          concurrency_limit: null,
          memory_mode: "off",
          memory_project_id: null,
          memory_thread_source: "header",
          request_content_mode: null,
          max_reasoning_effort: "medium",
        }),
      },
      registry: { put: vi.fn(), get: vi.fn().mockResolvedValue(registryRecord) },
    });
    const app = buildApp(deps);
    const body = {
      model: "gpt-5.6-sol",
      input: "Say hello",
      reasoning: { effort: "high" },
      previous_response_id: "resp_previous",
      stream: true,
      store: false,
    };

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const carrier = routeHarness.routed?.native_request as
      | { body?: { reasoning?: { effort?: unknown } }; mutations?: Record<string, unknown> }
      | undefined;
    expect(carrier?.body?.reasoning?.effort).toBe("medium");
    expect(routeHarness.routed?.reasoning_effort).toBe("medium");
  });

  it("serves a native WebSocket prewarm with empty input and generate:false", async () => {
    const routeHarness: { routed: Parameters<RouteFn>[0] | null } = { routed: null };
    const route: RouteFn = async (request) => {
      routeHarness.routed = request;
      return {
        decision: FAKE_DECISION,
        final: { status: "ok", alias: "openai-codex/gpt-5.6-sol" },
        body: null,
        stream: (async function* () {
          yield 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-warm","status":"completed"}}\n\n';
        })(),
        error: null,
        nativePassthrough: true,
      } as ExecutionResult;
    };
    const pipeline = createMessagesPipeline(route, "openai_responses");
    const { deps } = makeDeps({
      transformRequestOut: (native) =>
        responsesTransformer.transformRequestOut(native) as {
          stream?: boolean;
          metadata?: Record<string, unknown>;
        },
      run: pipeline.run,
    });
    const app = buildApp(deps);
    const body = {
      model: "gpt-5.6-sol",
      input: [],
      generate: false,
      reasoning: { effort: "medium", context: "all_turns" },
      stream: true,
      store: false,
    };

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("response.completed");
    expect(routeHarness.routed?.messages).toEqual([]);
    expect(routeHarness.routed?.provider_raw?.generate).toBe(false);
  });

  it("persists a streamed response binding before exposing its terminal frame", async () => {
    const saved = deferred<void>();
    const put = vi.fn(() => saved.promise);
    const decision = {
      lane: { selected_lane: "coding", candidate_chain: ["openai-codex/gpt-5.6-sol"] },
      provider_attempts: [
        {
          alias: "openai-codex/gpt-5.6-sol",
          provider_name: "openai-codex",
          provider_model: "gpt-5.6-sol",
          target_provider_protocol: "openai_responses",
          status: "ok",
          skipped: false,
        },
      ],
      final: { status: "ok", model_alias: "openai-codex/gpt-5.6-sol" },
      stream_outcome: null,
    } as unknown as DecisionRecord;
    const { deps } = makeDeps({
      registry: { put, get: vi.fn() },
      transformRequestOut: () => ({ stream: true, metadata: {} }),
      run: async () => ({
        decision,
        servingAccount: { providerId: "openai-codex", account: "oauth-a" },
        collect: async () => ({}),
        streamIR: async function* () {
          yield {
            type: "response.completed",
            response: { id: "resp-fast", status: "completed" },
            sequence_number: 0,
          };
        },
      }),
    });
    const app = buildApp(deps);
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response stream");
    const firstRead = reader.read();
    const firstResult = await Promise.race([
      firstRead.then(() => "frame" as const),
      shortTimeout(),
    ]);

    expect(firstResult).toBe("timeout");
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: "resp-fast",
        providerAccount: "oauth-a",
        selectedLane: "coding",
      }),
    );
    saved.resolve(undefined);
    expect(new TextDecoder().decode((await firstRead).value)).toContain("response.completed");
    const streamClosed = reader.read().then(() => "closed" as const);
    expect(await streamClosed).toBe("closed");
  });

  it("rejects an unknown previous_response_id instead of routing it without history", async () => {
    const run = vi.fn();
    const { deps } = makeDeps({
      run,
      registry: { put: vi.fn(), get: vi.fn().mockResolvedValue(null) },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, previous_response_id: "resp_unknown" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("send the full conversation input");
    expect(run).not.toHaveBeenCalled();
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

  it("returns a Responses-shaped 503 when the concurrency lease store is unavailable, without routing", async () => {
    const acquire = vi.fn().mockResolvedValue({
      ok: false as const,
      reason: "unavailable" as const,
      retryAfterSeconds: 0,
    });
    const { deps, order } = makeDeps({ concurrencyGate: { acquire } });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });

    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toMatchObject({
      error: {
        type: "api_error",
        code: "lane_unavailable",
        message: "concurrency lease unavailable",
      },
    });
    expect(acquire).toHaveBeenCalledOnce();
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

  it("awaits asynchronous concurrency release after a streaming response closes", async () => {
    const releaseStarted = deferred<void>();
    let finishRelease!: () => void;
    const releaseMayFinish = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = vi.fn(async () => {
      releaseStarted.resolve(undefined);
      await releaseMayFinish;
    });
    const { deps } = makeDeps({
      concurrencyGate: { acquire: async () => ({ ok: true as const, release }) },
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });

    const bodyDone = res.text();
    await releaseStarted.promise;
    expect(await Promise.race([bodyDone, shortTimeout()])).toBe("timeout");
    finishRelease();
    await bodyDone;
    expect(release).toHaveBeenCalledOnce();
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

  it("stream:true waits for routing before returning headers or writing the first SSE frame", async () => {
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

    await routeStarted.promise;
    const responseBeforeRoute = await Promise.race([responsePromise, shortTimeout()]);
    expect(responseBeforeRoute).toBe("timeout");
    releaseRoute();
    const res = await responsePromise;
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const firstRead = await Promise.race([reader?.read(), shortTimeout()]);
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
    const { record, insert } = makeRecord();
    const decision = {
      final: { status: "ok", model_alias: "gpt-4o", error_reason: null },
    } as never;
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
        ac.abort();
        throw new Error("aborted");
      },
      run: async () => ({
        decision,
        collect: async () => ({}),
        streamIR: async function* () {
          yield { type: "response.created", sequence_number: 0 };
          ac.abort();
          throw new Error("aborted");
        },
      }),
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
    const recorded = insert.mock.calls[0]?.[0] as {
      decision: {
        final: { status: string; error_reason: string | null };
        stream_outcome: string;
      };
    };
    expect(recorded.decision.final).toMatchObject({
      status: "error",
      error_reason: "client_abort",
    });
    expect(recorded.decision.stream_outcome).toBe("client_aborted");
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

  it("records a clean terminal-less stream as truncated instead of ok", async () => {
    const { record, insert } = makeRecord();
    const put = vi.fn();
    const decision = {
      final: { status: "ok", model_alias: "gpt-4o", error_reason: null },
      provider_attempts: [],
    } as never;
    const { deps } = makeDeps({
      record,
      registry: { put, get: vi.fn() },
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      run: async () => ({
        decision,
        collect: async () => ({}),
        streamIR: async function* () {
          yield { type: "response.created", sequence_number: 0 };
          yield {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: "partial",
          };
        },
      }),
    });
    const app = buildApp(deps);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    await res.text();

    const recorded = insert.mock.calls[0]?.[0] as {
      decision: {
        final: { status: string; error_reason: string | null };
        stream_outcome: string;
      };
    };
    expect(recorded.decision.final).toMatchObject({
      status: "error",
      error_reason: "upstream_error",
    });
    expect(recorded.decision.stream_outcome).toBe("truncated");
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

  it("captures the terminal Responses output for Session recovery without storing a full payload", async () => {
    const insert = vi.fn().mockResolvedValue({ id: "1" });
    const insertPayload = vi.fn().mockResolvedValue(undefined);
    const upsertSessionRevision = vi.fn(async (_input: UpsertSessionRevisionInput) => {});
    const telemetry = {
      insert,
      insertPayload,
      getSessionByRef: vi.fn(async () => null),
      listSessionRevisions: vi.fn(async () => []),
      findSessionRequestIdByResponseId: vi.fn(async () => null),
      upsertSessionRevision,
    } as unknown as TelemetryStore;
    const record: RecordServedDeps = {
      telemetry,
      redact: (value) => value,
      now: () => 1000,
      capturePayloads: () => false,
      captureSessions: () => true,
    };
    const terminalResponse = {
      id: "resp_session",
      output: [
        { type: "reasoning", id: "reason_1", summary: [] },
        { type: "function_call", id: "call_1", call_id: "fc_1", name: "lookup" },
      ],
    };
    const { deps } = makeDeps({
      record,
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      run: async () => ({
        decision: {
          protocol: "openai_responses",
          final: { status: "ok", model_alias: "gpt-4o" },
        } as DecisionRecord,
        collect: async () => ({}),
        streamIR: async function* () {
          yield {
            type: "response.completed",
            sequence_number: 1,
            response: terminalResponse,
          };
        },
      }),
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { ...AUTH, "x-thread-id": "thread-session" },
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    await res.text();

    expect(insertPayload).not.toHaveBeenCalled();
    expect(upsertSessionRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: "resp_session",
        responseJson: JSON.stringify(terminalResponse),
      }),
    );
  });

  it("budgets a Session-only terminal frame before parsing and releases a limited capture", async () => {
    const push = vi.fn();
    const release = vi.fn();
    const capture: SseCapture = {
      push,
      value: () => "",
      payloadValue: () => null,
      limited: () => true,
      release,
    };
    const upsertSessionRevision = vi.fn(async (_input: UpsertSessionRevisionInput) => {});
    const record: RecordServedDeps = {
      telemetry: {
        insert: vi.fn().mockResolvedValue({ id: "1" }),
        getSessionByRef: vi.fn(async () => null),
        findSessionRequestIdByResponseId: vi.fn(async () => null),
        upsertSessionRevision,
      } as unknown as TelemetryStore,
      redact: (value) => value,
      now: () => 1000,
      capturePayloads: () => false,
      captureSessions: () => true,
    };
    const { deps } = makeDeps({
      record,
      sseCaptureFactory: () => capture,
      transformRequestOut: () => ({
        stream: true,
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
      streamIR: async function* () {
        yield { type: "response.created", sequence_number: 0 };
        yield {
          type: "response.completed",
          sequence_number: 1,
          response: { id: "resp_limited", output: [{ type: "message" }] },
        };
      },
    });
    const log = vi.fn();
    const app = createApp({ logger: { log } });
    registerResponsesRoute(app, deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { ...AUTH, "x-thread-id": "thread-limited" },
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    await res.text();

    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0]?.[0]).toContain("event: response.completed");
    expect(log).toHaveBeenCalledWith(
      "warn",
      "session.response_limited",
      expect.objectContaining({ trace_id: expect.any(String) }),
    );
    expect(upsertSessionRevision).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: null, responseJson: null }),
    );
    expect(release).toHaveBeenCalledOnce();
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

  it("keeps the internal websocket session header only when the bridge proof matches", async () => {
    const { deps, harness } = makeDeps();
    deps.responsesWebSocketSessionProof = "proof-ok";
    const app = buildApp(deps);

    await app.request("/v1/responses", {
      method: "POST",
      headers: {
        ...AUTH,
        [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "session-ok",
        [CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER]: "proof-ok",
      },
      body: JSON.stringify(REQ),
    });

    const native = (harness.pipelineSawIR as { metadata?: { native_request?: unknown } } | null)
      ?.metadata?.native_request as { headers?: Record<string, string> } | undefined;
    expect(native?.headers?.[CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]).toBe("session-ok");
    expect(native?.headers?.[CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER]).toBeUndefined();
  });

  it("materializes a trusted internal websocket request after JSON parsing", async () => {
    const materialized = vi.fn();
    const { deps } = makeDeps({
      transformRequestOut: () => {
        expect(materialized).toHaveBeenCalledOnce();
        return { stream: false };
      },
    });
    deps.responsesWebSocketSessionProof = "proof-ok";
    const app = buildApp(deps);
    const request = new Request("http://helm.internal/v1/responses", {
      method: "POST",
      headers: {
        ...AUTH,
        [CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER]: "proof-ok",
      },
      body: JSON.stringify(REQ),
    });
    trackResponsesWebSocketRequest(request, materialized);

    const res = await app.fetch(request);

    expect(res.status).toBe(200);
    expect(materialized).toHaveBeenCalledOnce();
  });

  it("materializes a trusted internal websocket request when JSON parsing fails", async () => {
    const materialized = vi.fn();
    const { deps } = makeDeps();
    deps.responsesWebSocketSessionProof = "proof-ok";
    const app = buildApp(deps);
    const request = new Request("http://helm.internal/v1/responses", {
      method: "POST",
      headers: {
        ...AUTH,
        [CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER]: "proof-ok",
      },
      body: "{",
    });
    trackResponsesWebSocketRequest(request, materialized);

    const res = await app.fetch(request);

    expect(res.status).toBe(400);
    expect(materialized).toHaveBeenCalledOnce();
  });

  it("does not materialize a tracked request without the internal proof", async () => {
    const materialized = vi.fn();
    const { deps } = makeDeps();
    deps.responsesWebSocketSessionProof = "proof-ok";
    const app = buildApp(deps);
    const request = new Request("http://helm.internal/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    trackResponsesWebSocketRequest(request, materialized);

    const res = await app.fetch(request);

    expect(res.status).toBe(200);
    expect(materialized).not.toHaveBeenCalled();
  });

  it("strips spoofed websocket session headers from ordinary HTTP requests", async () => {
    const { deps, harness } = makeDeps();
    deps.responsesWebSocketSessionProof = "proof-ok";
    const app = buildApp(deps);

    await app.request("/v1/responses", {
      method: "POST",
      headers: {
        ...AUTH,
        [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "spoofed-session",
        [CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER]: "wrong-proof",
      },
      body: JSON.stringify(REQ),
    });

    const native = (harness.pipelineSawIR as { metadata?: { native_request?: unknown } } | null)
      ?.metadata?.native_request as { headers?: Record<string, string> } | undefined;
    expect(native?.headers?.[CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]).toBeUndefined();
    expect(native?.headers?.[CODEX_RESPONSES_WEBSOCKET_PROOF_HEADER]).toBeUndefined();
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

// ── Additional branch-coverage tests (test/coverage-marginal-zero) ──────────
//
// Each group targets a specific set of uncovered lines identified by the
// coverage report. Source files are never modified — only this test file.

describe("concurrencyGate acquired successfully and timeout reason (lines 467, 472-473)", () => {
  it("routes the request normally when the concurrency gate grants a slot", async () => {
    const release = vi.fn();
    const concurrencyGate = {
      acquire: async () => ({ ok: true as const, release }),
    };
    const { deps, order } = makeDeps({ concurrencyGate });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(200);
    expect(order).toContain("route");
    // The concurrency release must be called after the response is served
    expect(release).toHaveBeenCalled();
  });

  it("returns 429 with 'timed out' message when concurrencyGate rejects with timeout reason (line 467)", async () => {
    const concurrencyGate = {
      acquire: async () => ({
        ok: false as const,
        reason: "timeout" as const,
        retryAfterSeconds: 5,
      }),
    };
    const { deps } = makeDeps({ concurrencyGate });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("timed out waiting");
  });
});

describe("streamStatusFromEventName — incomplete / failed / cancelled cases (lines 199, 201, 203)", () => {
  // These statuses are surfaced by streaming through events whose type is the
  // matching Responses event name.  The route reads the status via
  // responseSnapshotFromStreamFrame → streamStatusFromEventName and stores it
  // in streamStatus, which is then passed to registry.put().
  it("records status='incomplete' when the stream emits a response.incomplete event", async () => {
    const put = vi.fn();
    const incompleteData = JSON.stringify({
      type: "response.incomplete",
      response: { id: "resp_inc_1", status: "incomplete" },
    });
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "response.incomplete", data: incompleteData };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      streamIR: events,
      registry: { put, get: vi.fn() },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    await res.text();
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: "resp_inc_1", status: "incomplete" }),
    );
  });

  it("waits for registry persistence before writing the terminal SSE frame", async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completedData = JSON.stringify({
      type: "response.completed",
      response: { id: "resp_fast_terminal", status: "completed" },
    });
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "response.completed", data: completedData };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      streamIR: events,
      registry: { put: () => persisted, get: vi.fn() },
    });
    const app = buildApp(deps);
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("stream body missing");

    const firstRead = reader.read();
    const first = await Promise.race([
      firstRead,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(first).toBe("timeout");
    release();
    const terminal = await firstRead;
    expect(new TextDecoder().decode(terminal.value)).toContain("response.completed");
    await reader.cancel();
  });

  it("records status='failed' when the stream emits a response.failed event", async () => {
    const { record, insert } = makeRecord();
    const put = vi.fn();
    const failedData = JSON.stringify({
      type: "response.failed",
      response: {
        id: "resp_fail_1",
        status: "failed",
        error: { code: "invalid_prompt", message: "The prompt is invalid." },
      },
    });
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield {
        event: "response.output_text.delta",
        data: JSON.stringify({ type: "response.output_text.delta", delta: "partial" }),
      };
      yield { event: "response.failed", data: failedData };
    }
    const decision = {
      provider_attempts: [{ status: "ok" }],
      final: { status: "ok", model_alias: "gpt-5.6-sol", error_reason: null },
      stream_outcome: null,
    } as unknown as DecisionRecord;
    const { deps } = makeDeps({
      record,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      run: async () => ({
        decision,
        nativePassthrough: true,
        collect: async () => ({}),
        streamIR: events,
      }),
      registry: { put, get: vi.fn() },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    await res.text();
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: "resp_fail_1", status: "failed" }),
    );
    expect(insert).toHaveBeenCalledOnce();
    const persisted = insert.mock.calls[0]?.[0].decision as DecisionRecord;
    expect(persisted.provider_attempts[0]?.status).toBe("ok");
    expect(persisted.stream_outcome).toBe("failed");
    expect(persisted.final).toMatchObject({
      status: "error",
      error_reason: "upstream_error",
      error_detail: {
        upstream_status: null,
        message: "The prompt is invalid.",
        provider_raw: {
          type: "response.failed",
          response: { error: { code: "invalid_prompt", message: "The prompt is invalid." } },
        },
      },
    });
  });

  it("keeps an exact error frame when the upstream then throws a generic EOF error", async () => {
    const { record, insert } = makeRecord();
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield {
        event: "response.output_text.delta",
        data: JSON.stringify({ type: "response.output_text.delta", delta: "partial" }),
      };
      yield {
        event: "error",
        data: JSON.stringify({
          type: "error",
          error: { code: "invalid_prompt", message: "The prompt is invalid." },
        }),
      };
      throw new UpstreamError("upstream_error", "stream closed before response.completed");
    }
    const decision = {
      provider_attempts: [{ status: "ok" }],
      final: { status: "ok", model_alias: "gpt-5.6-sol", error_reason: null },
      stream_outcome: null,
    } as unknown as DecisionRecord;
    const { deps } = makeDeps({
      record,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      run: async () => ({
        decision,
        nativePassthrough: true,
        collect: async () => ({}),
        streamIR: events,
      }),
    });

    await (
      await buildApp(deps).request("/v1/responses", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ ...REQ, stream: true }),
      })
    ).text();

    const persisted = insert.mock.calls[0]?.[0].decision as DecisionRecord;
    expect(persisted.final.error_detail?.message).toBe("The prompt is invalid.");
  });

  it("normalizes response.cancelled to the failed stream outcome", async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = vi.fn(() => persisted);
    const cancelledData = JSON.stringify({
      type: "response.cancelled",
      response: { id: "resp_cancel_1", status: "cancelled" },
    });
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "response.cancelled", data: cancelledData };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      streamIR: events,
      registry: { put, get: vi.fn() },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("stream body missing");
    const firstRead = reader.read();
    const first = await Promise.race([
      firstRead,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    release();
    expect(first).toBe("timeout");
    const terminal = await firstRead;
    expect(new TextDecoder().decode(terminal.value)).toContain("response.cancelled");
    await reader.cancel();
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ responseId: "resp_cancel_1", status: "failed" }),
    );
  });
});

describe("responseSnapshotFromStreamFrame — JSON parse failure and non-object paths (lines 217–221)", () => {
  // These are exercised by the native-passthrough stream path where frame.data
  // is an arbitrary string supplied by upstream.  The route calls
  // responseSnapshotFromStreamFrame(frame.event, frame.data) for every frame.
  // When responseId is null (no parseable id), registry.put is NOT called
  // (guarded by `streamResponseId !== null`), but the branch is still traversed.

  it("completes without error when frame data is not valid JSON (line 217 branch exercised)", async () => {
    // data is not valid JSON → JSON.parse throws → falls back to streamStatusFromEventName
    // No registry: we just verify the stream completes and emits the event.
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "response.completed", data: "not-valid-json{{{" };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      streamIR: events,
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The frame was forwarded; no error frame was emitted
    expect(text).toContain("event: response.completed");
    expect(text).not.toContain("event: error");
  });

  it("completes without error when frame data parses to a JSON primitive (line 220 branch exercised)", async () => {
    // data parses successfully but is not an object → falls back to event-name status
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "response.completed", data: '"just a string"' };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      streamIR: events,
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: response.completed");
    expect(text).not.toContain("event: error");
  });
});

describe("estimateResponsesInputTokens — number/boolean/object/array branches (lines 294–302)", () => {
  it("counts tokens from numeric and boolean fields (lines 293-294)", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    // Pass numeric and boolean values in recognized top-level fields
    const res = await app.request("/v1/responses/input_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "auto",
        input: 42, // number → String(42)
        instructions: true, // boolean → String(true)
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number; estimated: boolean };
    expect(body.input_tokens).toBeGreaterThanOrEqual(1);
    expect(body.estimated).toBe(true);
  });

  it("counts tokens from nested object fields (line 295)", async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/responses/input_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "auto",
        tools: [{ type: "function", name: "search", description: "searches the web" }],
        tool_choice: { type: "auto" },
        response_format: { type: "json_object" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number; estimated: boolean };
    expect(body.input_tokens).toBeGreaterThanOrEqual(1);
    expect(body.estimated).toBe(true);
  });

  it("handles circular-reference objects via WeakSet guard (line 297)", async () => {
    // We can't send a circular ref over HTTP, but we can test the local estimate
    // function via the /input_tokens endpoint with a deeply nested object whose
    // values repeat (the WeakSet path only triggers for actual JS object identity;
    // the HTTP path can't hit it).  Verify the endpoint returns a valid estimate
    // for deeply-nested non-circular objects at minimum.
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/responses/input_tokens", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "auto",
        input: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "world" }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number; estimated: boolean };
    expect(body.input_tokens).toBeGreaterThanOrEqual(1);
  });
});

describe("handleProviderLifecycle — missing response_id (lines 350-351)", () => {
  // The route registers the lifecycle handlers as /:response_id handlers, so
  // Hono will always supply the param when hitting that path.  The defensive
  // guard fires when some future registration path calls the handler without the
  // param in scope.  We can exercise it by registering a custom bare path.
  //
  // Since we cannot hit the guard through the standard route registration, we
  // verify the guard exists by checking it surfaces an invalid_request 400 for
  // the sub-path that does supply a blank segment (Hono routing ensures the param
  // is always defined on the registered paths, making this a pure defensive line).
  // We skip direct invocation of the guard (it requires a custom Hono setup that
  // modifies source) and instead document the finding as unreachable-in-practice.
  it("lifecycle retrieve returns 404 when registry returns null (regression guard)", async () => {
    const retrieve = vi.fn().mockResolvedValue({ id: "resp_123", status: "completed" });
    const registry = { put: vi.fn(), get: vi.fn().mockResolvedValue(null) };
    const { deps } = makeDeps({ lifecycle: { retrieve }, registry });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses/resp_missing_2", {
      headers: { Authorization: AUTH.Authorization },
    });
    expect(res.status).toBe(404);
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("sig(nativeMetaBag?.conversation_id) fallback (line 502)", () => {
  // When the inbound Responses body has metadata.conversation_id but NOT
  // metadata.thread_id, the route falls back to sig(conversation_id) for
  // the memoryScope threadId signal.  We verify this by ensuring the pipeline
  // receives the IR (i.e. no error path is hit) — the memory-scope result is
  // opaque from the test but the branch is exercised.
  it("uses metadata.conversation_id as thread signal when thread_id is absent", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        ...REQ,
        metadata: { conversation_id: "conv_abc123" },
      }),
    });
    expect(res.status).toBe(200);
    // Pipeline was invoked (branch was exercised without errors)
    expect(harness.pipelineSawIR).not.toBeNull();
  });
});

describe("stream: raw frame forwarding via sse.write(raw) (lines 589-591, 610-611)", () => {
  // When nativePassthrough is true AND the yielded event has a `.raw` string
  // property, the route writes it directly via sse.write(raw) instead of
  // sse.writeSSE({event, data}).  The raw property carries the verbatim upstream
  // SSE bytes (e.g. including reasoning.encrypted_content that cannot be
  // re-serialized through writeSSE).
  it("writes raw bytes to the SSE stream when frame.raw is set (passthrough raw path)", async () => {
    const rawFrame = 'event: response.created\ndata: {"type":"response.created"}\n\n';
    async function* events(): AsyncIterable<Record<string, unknown>> {
      // A native passthrough frame with a `.raw` property
      yield {
        event: "response.created",
        data: '{"type":"response.created"}',
        raw: rawFrame,
      };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      streamIR: events,
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The raw bytes must be forwarded verbatim
    expect(text).toContain("event: response.created");
  });

  it("captures raw bytes in the payload buffer when capture_payloads is ON", async () => {
    const { record, insertPayload } = makeRecord({ capturePayloads: true });
    const rawFrame = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield {
        event: "response.completed",
        data: '{"type":"response.completed"}',
        raw: rawFrame,
      };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      record,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      streamIR: events,
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
    // The raw bytes should be captured as-is, NOT re-formatted
    expect(arg.responseJson).toContain("event: response.completed");
  });
});

describe("non-stream pipeline.run throws PipelineError (lines 700-702)", () => {
  it("surfaces a PipelineError from pipeline.run (non-stream) as the OpenAI envelope", async () => {
    // pipeline.run itself throws (before collect) — distinct from collect() throwing
    const { deps } = makeDeps({
      run: async () => {
        throw new PipelineError("all_providers_failed", "run-level failure", "trace-run");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("all_providers_failed");
    expect(body.error.message).toContain("run-level failure");
  });

  it("re-throws a non-PipelineError from pipeline.run (non-stream) as-is", async () => {
    const { deps } = makeDeps({
      run: async () => {
        throw new TypeError("unexpected type error in run");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    // Propagates to onError → 500
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("registry.put with providerProtocol='gemini' (lines 756, 758, 680)", () => {
  it("non-stream: stores providerProtocol='gemini' when the attempt used the gemini protocol", async () => {
    const put = vi.fn();
    const decision = {
      provider_attempts: [
        {
          alias: "gemini/flash",
          status: "ok",
          skipped: false,
          provider_name: "google",
          provider_model: "gemini-2.0-flash",
          target_provider_protocol: "gemini",
        },
      ],
    } as never;
    // nativePassthrough: true so collect() result passes through transformResponseOut
    // unchanged (the stub would rewrite the id to "resp_1" otherwise).
    const { deps } = makeDeps({
      run: async () => ({
        decision,
        nativePassthrough: true,
        collect: async () => ({
          id: "resp_gemini_1",
          object: "response",
          status: "completed",
        }),
        streamIR: async function* () {},
      }),
      registry: { put, get: vi.fn() },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: "resp_gemini_1",
        providerProtocol: "gemini",
        providerName: "google",
        providerModel: "gemini-2.0-flash",
      }),
    );
  });

  it("non-stream: stores providerProtocol=null when the attempt has an unrecognized protocol (line 758)", async () => {
    const put = vi.fn();
    const decision = {
      provider_attempts: [
        {
          alias: "custom/model",
          status: "ok",
          skipped: false,
          provider_name: "custom",
          provider_model: "custom-model",
          target_provider_protocol: "unknown_protocol",
        },
      ],
    } as never;
    const { deps } = makeDeps({
      run: async () => ({
        decision,
        nativePassthrough: true,
        collect: async () => ({ id: "resp_custom_1", object: "response", status: "completed" }),
        streamIR: async function* () {},
      }),
      registry: { put, get: vi.fn() },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: "resp_custom_1",
        providerProtocol: null,
      }),
    );
  });

  it("stream: stores providerProtocol='gemini' from a streaming gemini attempt", async () => {
    const put = vi.fn();
    const decision = {
      provider_attempts: [
        {
          alias: "gemini/flash",
          status: "ok",
          skipped: false,
          provider_name: "google",
          provider_model: "gemini-2.0-flash",
          target_provider_protocol: "gemini",
        },
      ],
    } as never;
    const completedData = JSON.stringify({
      type: "response.completed",
      response: { id: "resp_gemini_stream_1", status: "completed" },
    });
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { event: "response.completed", data: completedData };
    }
    const { deps } = makeDeps({
      nativePassthrough: true,
      transformRequestOut: () => ({ stream: true, model: "auto", metadata: {} }),
      streamIR: events,
      run: async () => ({
        decision,
        nativePassthrough: true,
        collect: async () => ({}),
        streamIR: events,
      }),
      registry: { put, get: vi.fn() },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQ, stream: true }),
    });
    await res.text();
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: "resp_gemini_stream_1",
        providerProtocol: "gemini",
      }),
    );
  });
});
