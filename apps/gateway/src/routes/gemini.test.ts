import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { type GeminiRouteDeps, registerGeminiRoute } from "./gemini.js";
import type { MessagesIdentity } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";
import type { RecordServedDeps } from "./payload-capture.js";

// POST /v1beta/models/{model}:{generateContent|streamGenerateContent} — Gemini
// inbound (issue #34). These tests pin the route CONTRACT: auth (x-goog-api-key
// preferred, Bearer fallback) → translate-out → MODEL BACKFILL → route →
// translate-back, with all business logic stubbed. The route is PURE HTTP glue
// (CLAUDE.md principle 1). Streaming snapshots are written as nameless `data:`
// frames with NO `event:` name and NO [DONE] (Gemini wire form, docs/05).

const GEMINI_AUTH = { "x-goog-api-key": "helm_live_secret", "Content-Type": "application/json" };

const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };

const REQ_BODY = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

// A fake DecisionRecord stand-in the route hands opaquely to recordServed →
// redact → telemetry.insert (it never inspects fields).
const FAKE_DECISION = { final: { status: "ok", model_alias: "gemini-2.0-flash" } } as never;

// A canned Gemini-native response the stub responseOut produces.
const GEMINI_RESPONSE = {
  candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};

interface Harness {
  order: string[];
  pipelineSawIR: Record<string, unknown> | null;
  pipelineSawAbort: boolean;
}

function makeDeps(
  over: {
    collect?: () => Promise<unknown>;
    streamEvents?: () => AsyncIterable<Record<string, unknown>>;
    authed?: boolean;
    abort?: boolean;
    transformRequestOut?: (native: unknown) => unknown;
    identity?: MessagesIdentity;
    rateLimiter?: GeminiRouteDeps["rateLimiter"];
    concurrencyGate?: GeminiRouteDeps["concurrencyGate"];
    record?: RecordServedDeps;
  } = {},
): { deps: GeminiRouteDeps; harness: Harness } {
  const harness: Harness = { order: [], pipelineSawIR: null, pipelineSawAbort: false };

  const deps: GeminiRouteDeps = {
    rateLimiter: over.rateLimiter,
    concurrencyGate: over.concurrencyGate,
    record: over.record,
    auth: {
      resolve: async (cred) => {
        harness.order.push(`auth:${cred ?? "null"}`);
        return over.authed === false ? null : (over.identity ?? IDENTITY);
      },
    },
    transformer: {
      transformRequestOut: (native) => {
        harness.order.push("translate-out");
        if (over.transformRequestOut)
          return over.transformRequestOut(native) as Record<string, unknown>;
        // The real transformer defaults model:"gemini"; the route must backfill the
        // path model. Return that default so the backfill assertion is meaningful.
        return { model: "gemini", messages: [{ role: "user", content: "hi" }], metadata: {} };
      },
      transformResponseOut: (ir) => {
        harness.order.push("translate-back");
        return { ...GEMINI_RESPONSE, __ir: ir };
      },
      transformErrorOut: (err) => {
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
      },
    },
    pipeline: {
      run: async (ir, _identity, signal) => {
        harness.order.push("route");
        harness.pipelineSawIR = ir;
        if (over.abort === true) {
          if (signal.aborted) harness.pipelineSawAbort = true;
          signal.addEventListener("abort", () => {
            harness.pipelineSawAbort = true;
          });
        }
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
  return { deps, harness };
}

function buildApp(deps: GeminiRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  registerGeminiRoute(app, deps);
  return app;
}

// Recording dep with insert + insertPayload spies (mirrors the chat telemetry
// harness). redact is the identity so a test can assert it ran on the decision.
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

describe("POST /v1beta/models/{model}:generateContent (Gemini inbound)", () => {
  it("non-stream: auth → translate-out → route → translate-back, returns Gemini JSON", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    expect(body.candidates[0]?.content.parts[0]?.text).toBe("hello");
    expect(harness.order).toEqual([
      "auth:helm_live_secret",
      "translate-out",
      "route",
      "translate-back",
    ]);
  });

  it("backfills the path model into the IR the pipeline receives", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    await app.request("/v1beta/models/gemini-1.5-pro:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    // Must NOT leak the transformer's default model:"gemini" to the router.
    expect(harness.pipelineSawIR?.model).toBe("gemini-1.5-pro");
  });

  it("prefers x-goog-api-key but falls back to Authorization: Bearer", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);

    await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: { Authorization: "Bearer bearer_key", "Content-Type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(harness.order[0]).toBe("auth:bearer_key");
  });

  it("rejects a missing/invalid key with a 401 Gemini error and never routes", async () => {
    const { deps, harness } = makeDeps({ authed: false });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": "wrong", "Content-Type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { status: string } };
    expect(body.error.status).toBe("UNAUTHENTICATED");
    expect(harness.order).not.toContain("route");
  });

  it("returns 404 for a non-generateContent path (parseGeminiPath null)", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1beta/models/gemini-2.0-flash:countTokens", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(404);
    expect(harness.order).not.toContain("route");
  });

  it("rate-limits after auth with a 429 Gemini envelope and limit headers, without translating or routing", async () => {
    const { deps, harness } = makeDeps({
      rateLimiter: {
        check: async (probe) => {
          harness.order.push(`rate-limit:${probe.keyId}`);
          return {
            allowed: false,
            limitedBy: "rpm",
            limit: 60,
            remaining: 0,
            resetSeconds: 42,
            retryAfterSeconds: 12,
          };
        },
      },
    });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(res.headers.get("x-ratelimit-limit")).toBe("60");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(res.headers.get("x-ratelimit-reset")).toBe("42");
    const body = (await res.json()) as { error: { code: number; status: string } };
    expect(body.error).toMatchObject({ code: 429, status: "RESOURCE_EXHAUSTED" });
    expect(harness.order).toEqual(["auth:helm_live_secret", "rate-limit:k1"]);
    expect(harness.pipelineSawIR).toBeNull();
  });

  it("returns a 429 RESOURCE_EXHAUSTED Gemini envelope when the concurrency gate rejects, without routing", async () => {
    const { deps, harness } = makeDeps({
      concurrencyGate: {
        acquire: async () => ({
          ok: false as const,
          reason: "timeout" as const,
          retryAfterSeconds: 9,
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
    expect(res.headers.get("retry-after")).toBe("9");
    const body = (await res.json()) as { error: { status: string } };
    expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(harness.pipelineSawIR).toBeNull(); // never routed
  });

  it("maps a malformed JSON body to 400 INVALID_ARGUMENT, after auth, without routing", async () => {
    const { deps, harness } = makeDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { status: string } };
    expect(body.error.status).toBe("INVALID_ARGUMENT");
    expect(harness.order).not.toContain("route");
  });

  it("maps a structurally invalid body (transformRequestOut throws) to a 400 Gemini error", async () => {
    const { deps, harness } = makeDeps({
      transformRequestOut: () => {
        throw new Error("contents: too_small");
      },
    });
    const app = buildApp(deps);
    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify({ contents: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { status: string } };
    expect(body.error.status).toBe("INVALID_ARGUMENT");
    expect(harness.order).not.toContain("route");
  });

  it("surfaces an all-providers-failed pipeline error as a Gemini envelope (not empty 200)", async () => {
    const { deps } = makeDeps({
      collect: async () => {
        throw new PipelineError("all_providers_failed", "all providers failed", "trace-1");
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
  });

  // ── Telemetry recording (the /admin/requests bug). The gemini face served LLM
  //    traffic but never recorded a telemetry row, so it was invisible in the
  //    admin Debug list. recordServed must fire on every served request.
  it("records a redacted telemetry row + payload for a served NON-STREAM request", async () => {
    const { record, insert, insertPayload, redact } = makeRecord();
    const { deps } = makeDeps({ record });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
    const arg = insert.mock.calls[0]?.[0] as { apiKeyId: string };
    expect(arg.apiKeyId).toBe("k1");
    expect(redact).toHaveBeenCalled();
    // The plaintext key must never reach the persisted telemetry row.
    expect(JSON.stringify(arg)).not.toContain("helm_live_secret");
    expect(insertPayload).toHaveBeenCalledOnce();
  });

  it("records a telemetry row for a served STREAM request after the stream drains", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
    }
    const { record, insert } = makeRecord();
    const { deps } = makeDeps({ record, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
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
    const res = await app.request("/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(200);
  });

  // ── Capture-payloads gating (review P2). With capture_payloads OFF the route
  //    must still write the telemetry row but NOT buffer/persist the body — the
  //    stream buffer is the unbounded growth vector this gate closes.
  it("capture_payloads OFF: a served stream records the telemetry row but NOT the payload", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
    }
    const { record, insert, insertPayload } = makeRecord({ capturePayloads: false });
    const { deps } = makeDeps({ record, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    await res.text();

    expect(insert).toHaveBeenCalledOnce();
    expect(insertPayload).not.toHaveBeenCalled();
  });

  // ── Terminal stream error frame must be appended to the captured body (review
  //    P2). A mid-stream error writes a nameless `data:` error frame to the
  //    client; that frame has to land in the persisted responseJson too.
  it("stream error frame is captured in the payload", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
      throw new PipelineError("all_providers_failed", "all providers failed", "trace-1");
    }
    const { record, insertPayload } = makeRecord({ capturePayloads: true });
    const { deps } = makeDeps({ record, streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    await res.text();

    expect(insertPayload).toHaveBeenCalledOnce();
    const arg = insertPayload.mock.calls[0]?.[0] as { responseJson: string };
    expect(arg.responseJson).toContain("UNAVAILABLE");
    expect(arg.responseJson).toContain("all providers failed");
  });
});

describe("POST /v1beta/models/{model}:streamGenerateContent?alt=sse (Gemini stream)", () => {
  it("writes nameless data: frames with NO event: name and NO [DONE]", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] };
      yield {
        candidates: [
          { content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { candidatesTokenCount: 2 },
      };
    }
    const { deps } = makeDeps({ streamEvents: events });
    const app = buildApp(deps);

    const res = await app.request("/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).not.toContain("event:");
    expect(text).not.toContain("[DONE]");
    // Each frame is a full snapshot; the final carries finishReason.
    expect(text).toContain("STOP");
  });

  it("passes the abort signal to the pipeline and emits NO error frame on client disconnect", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    const { deps } = makeDeps({ streamEvents: events, abort: true });
    const app = buildApp(deps);
    const res = await app.request("/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    const text = await res.text();
    // A benign abort must NOT write an error envelope into the stream.
    expect(text).not.toContain("UNAVAILABLE");
    expect(text).not.toContain('"error"');
  });

  it("emits a terminal Gemini error frame when the stream throws (non-abort)", async () => {
    async function* events(): AsyncIterable<Record<string, unknown>> {
      yield { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] };
      throw new PipelineError("all_providers_failed", "all providers failed", "trace-1");
    }
    const { deps } = makeDeps({ streamEvents: events });
    const app = buildApp(deps);
    const res = await app.request("/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: GEMINI_AUTH,
      body: JSON.stringify(REQ_BODY),
    });
    const text = await res.text();
    expect(text).toContain("error");
    expect(text).toContain("UNAVAILABLE");
  });
});
