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
    streamIR?: () => AsyncIterable<{ type: string; [k: string]: unknown }>;
    run?: ResponsesRouteDeps["pipeline"]["run"];
    rateLimiter?: ResponsesRouteDeps["rateLimiter"];
    concurrencyGate?: ResponsesRouteDeps["concurrencyGate"];
    identity?: MessagesIdentity;
    record?: RecordServedDeps;
  } = {},
): { deps: ResponsesRouteDeps; order: string[] } {
  const order: string[] = [];
  const deps: ResponsesRouteDeps = {
    rateLimiter: over.rateLimiter,
    concurrencyGate: over.concurrencyGate,
    record: over.record,
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
        (async (_ir, _identity, _signal) => {
          order.push("route");
          return {
            decision: FAKE_DECISION,
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

  it("returns OpenAI-shaped errors for unsupported Responses lifecycle endpoints", async () => {
    const cases: Array<[string, string]> = [
      ["GET", "/v1/responses/resp_123"],
      ["DELETE", "/v1/responses/resp_123"],
      ["POST", "/v1/responses/resp_123/cancel"],
      ["GET", "/v1/responses/resp_123/input_items"],
      ["POST", "/v1/responses/compact"],
      ["POST", "/v1/responses/input_tokens"],
      ["GET", "/responses/resp_123"],
      ["DELETE", "/openai/v1/responses/resp_123"],
    ];

    for (const [method, path] of cases) {
      const { deps, order } = makeDeps();
      const app = buildApp(deps);
      const res = await app.request(path, { method, headers: AUTH });
      expect(res.status, `${method} ${path}`).toBe(400);
      const body = (await res.json()) as { error: Record<string, string> };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain("not implemented");
      expect(order).toEqual(["auth"]);
    }
  });

  it("authenticates unsupported Responses lifecycle endpoints before returning unsupported", async () => {
    const { deps, order } = makeDeps({ authed: false });
    const app = buildApp(deps);
    const res = await app.request("/v1/responses/resp_123", { method: "GET" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("invalid_api_key");
    expect(order).toEqual(["auth"]);
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

  it("stream:true opens the Responses SSE before routing resolves", async () => {
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
    const firstRead = await Promise.race([reader?.read(), shortTimeout()]);
    expect(firstRead).not.toBe("timeout");
    const firstText = new TextDecoder().decode((firstRead as { value?: Uint8Array }).value);
    expect(parseSSE(firstText)[0]?.event).toBe("response.created");
    await routeStarted.promise;
    releaseRoute();
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
});
