import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { type GeminiRouteDeps, registerGeminiRoute } from "./gemini.js";
import type { MessagesIdentity } from "./messages.js";
import { PipelineError } from "./messages-pipeline.js";

// POST /v1beta/models/{model}:{generateContent|streamGenerateContent} — Gemini
// inbound (issue #34). These tests pin the route CONTRACT: auth (x-goog-api-key
// preferred, Bearer fallback) → translate-out → MODEL BACKFILL → route →
// translate-back, with all business logic stubbed. The route is PURE HTTP glue
// (CLAUDE.md principle 1). Streaming snapshots are written as nameless `data:`
// frames with NO `event:` name and NO [DONE] (Gemini wire form, docs/05).

const GEMINI_AUTH = { "x-goog-api-key": "helm_live_secret", "Content-Type": "application/json" };

const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };

const REQ_BODY = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

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
  } = {},
): { deps: GeminiRouteDeps; harness: Harness } {
  const harness: Harness = { order: [], pipelineSawIR: null, pipelineSawAbort: false };

  const deps: GeminiRouteDeps = {
    rateLimiter: over.rateLimiter,
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
