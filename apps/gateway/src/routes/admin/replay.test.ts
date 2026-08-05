import type { KeyStore, TelemetryStore } from "@helm/core";
import type { ApiKeyRecord, DecisionRecord, InternalRequest } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../app.js";
import type { ReplayWiring } from "./deps.js";
import { registerReplayRoutes, runReplay } from "./replay.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fakeKey(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "key_1",
    hash: "h",
    prefix: "helm_live_ab12",
    account_id: "acct_1",
    role: "user",
    name: null,
    allowed_lanes: null,
    allow_custom_model: false,
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
    max_reasoning_effort: null,
    ...overrides,
  };
}

function decision(
  reqId: string,
  final: DecisionRecord["final"] = {
    status: "ok",
    model_alias: "openai/gpt-4",
    provider_model: "gpt-4",
    error_reason: null,
  },
): DecisionRecord {
  return {
    request_id: reqId,
    final,
    provider_attempts: [{ alias: "openai/gpt-4", status: "ok", cost_usd: null }],
    cost_breakdown: { eval_usd: 0, completion_usd: null, total_usd: 0 },
  } as unknown as DecisionRecord;
}

interface Recorded {
  inserts: Array<{ decision: DecisionRecord; apiKeyId: string; createdAt: Date }>;
  payloads: Array<{ requestId: string; requestJson: string; responseJson: string | null }>;
  routeCalls: Array<{ req: InternalRequest; opts: unknown }>;
}

function fakeTelemetry(
  keyId: string | null,
  rec: Recorded,
  opts: { failInsert?: boolean; original?: DecisionRecord | null } = {},
): TelemetryStore {
  return {
    async getApiKeyId() {
      return keyId;
    },
    async getCreatedAt() {
      return null;
    },
    async insert(input) {
      if (opts.failInsert) throw new Error("telemetry down");
      rec.inserts.push(input);
      return { id: "tid" };
    },
    async insertPayload(input) {
      rec.payloads.push(input);
    },
    async prunePayloads() {},
    async queryRecent() {
      return [];
    },
    async queryPage() {
      return { rows: [], total: 0 };
    },
    // The ORIGINAL request's (redacted) DecisionRecord — carries the client
    // `protocol` + `requested_model` the replay path recovers. Default null so the
    // legacy / openai_chat tests exercise the body-shape inference fallback.
    async getByRequestId() {
      return opts.original ?? null;
    },
    async queryWindow() {
      return [];
    },
    async aggregate() {
      return {
        totals: {
          requests: 0,
          okCount: 0,
          errorCount: 0,
          totalCostUsd: null,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          avgLatencyMs: null,
          avgTps: null,
        },
        series: [],
        byModel: [],
      };
    },
    async usageByKey() {
      return [];
    },
    async getPayload() {
      return null;
    },
  };
}

// A minimal stored DecisionRecord stub for protocol/model recovery — runReplay only
// reads `.protocol` and `.requested_model` off it.
function storedDecision(protocol: string, requestedModel = "auto"): DecisionRecord {
  return { protocol, requested_model: requestedModel } as unknown as DecisionRecord;
}

// An OpenAI chat.completion body the routing core surfaces (the pipeline projects it
// to IR, then the protocol adapter renders the NATIVE response for capture).
function openAIResultBody(text = "yo"): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

function fakeKeyStore(keys: ApiKeyRecord[]): KeyStore {
  return {
    async list() {
      return keys;
    },
  } as unknown as KeyStore;
}

async function* sse(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

async function* sseThenThrow(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
  throw new Error("upstream stream broke");
}

function wiring(
  route: ReplayWiring["route"],
  rec: Recorded,
  overrides: Partial<ReplayWiring> = {},
): ReplayWiring {
  return {
    route: async (req, opts, signal) => {
      rec.routeCalls.push({ req, opts });
      return route(req, opts, signal);
    },
    redact: (p) => p,
    now: () => 1000,
    genTraceId: () => "new_trace",
    capturePayloads: () => true,
    costOf: () => 0.5,
    ...overrides,
  };
}

function emptyRec(): Recorded {
  return { inserts: [], payloads: [], routeCalls: [] };
}

const okBody = { model: "gpt-4", messages: [{ role: "user", content: "hi" }], max_tokens: 32000 };
const noop = () => {};

// ── runReplay ────────────────────────────────────────────────────────────────

describe("runReplay", () => {
  it("non-stream happy path: routes under a new trace id, captures, records once", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: { id: "resp_1", choices: [] },
      stream: null,
      error: null,
    });
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );

    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    // Telemetry recorded EXACTLY once, under the ORIGINAL key id + NEW trace.
    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]?.apiKeyId).toBe("key_1");
    expect(rec.inserts[0]?.decision.request_id).toBe("new_trace");
    // Payload captured verbatim.
    expect(rec.payloads).toHaveLength(1);
    expect(rec.payloads[0]?.requestId).toBe("new_trace");
    expect(rec.payloads[0]?.responseJson).toBe(JSON.stringify({ id: "resp_1", choices: [] }));
    // The re-issued request: new id, edited max_tokens, memory OFF, faithful caps.
    const call = rec.routeCalls[0];
    expect(call?.req.request_id).toBe("new_trace");
    expect(call?.req.stream).toBe(false);
    expect(call?.req.max_tokens).toBe(32000);
    expect(call?.req.metadata.memory_mode).toBe("off");
    expect(call?.opts).toEqual({
      allowCustomModel: false,
      keyPrefix: "helm_live_ab12",
      keyCaps: { allowedLanes: null, degradeLane: null, blockedModels: null },
    });
  });

  it("streaming path: drains the stream, backfills cost, captures assembled SSE", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: null,
      stream: sse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
      ]),
      error: null,
    });
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      {
        originalTraceId: "orig",
        body: { ...okBody, stream: true },
        signal: new AbortController().signal,
        log: noop,
      },
    );

    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    expect(rec.payloads[0]?.responseJson).toContain('"content":"hi"');
    // costOf() = 0.5 → backfilled onto the decision before it was recorded.
    expect(rec.inserts[0]?.decision.cost_breakdown.completion_usd).toBe(0.5);
    expect(rec.inserts).toHaveLength(1);
  });

  it("rejects a malformed body (400) without routing or recording", async () => {
    const rec = emptyRec();
    const out = await runReplay(
      {
        replay: wiring(async () => ({}) as never, rec),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      {
        originalTraceId: "orig",
        body: { messages: [] },
        signal: new AbortController().signal,
        log: noop,
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(400);
    expect(rec.routeCalls).toHaveLength(0);
    expect(rec.inserts).toHaveLength(0);
  });

  it("404s when the original request is unknown", async () => {
    const rec = emptyRec();
    const out = await runReplay(
      {
        replay: wiring(async () => ({}) as never, rec),
        telemetry: fakeTelemetry(null, rec),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "gone", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
    expect(rec.routeCalls).toHaveLength(0);
  });

  it("falls back to a live root key when the original key was deleted", async () => {
    const rec = emptyRec();
    const root = fakeKey({
      key_id: "k_root",
      prefix: "helm_live_root",
      role: "root",
      allow_custom_model: true,
    });
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: { ok: true },
      stream: null,
      error: null,
    });
    const logged: string[] = [];
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([root]), // original key_1 deleted; only root remains
      },
      {
        originalTraceId: "orig",
        body: okBody,
        signal: new AbortController().signal,
        log: (m) => logged.push(m),
      },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    // Routed under the ROOT key's identity + caps (not the dead key's).
    expect(rec.routeCalls[0]?.opts).toEqual({
      allowCustomModel: true,
      keyPrefix: "helm_live_root",
      keyCaps: { allowedLanes: null, degradeLane: null, blockedModels: null },
    });
    expect(rec.routeCalls[0]?.req.api_key_id).toBe("k_root");
    // Telemetry attributes the replay to the key ACTUALLY used.
    expect(rec.inserts[0]?.apiKeyId).toBe("k_root");
    // The fallback is logged for the audit trail.
    expect(logged).toContain("replay.root_key_fallback");
  });

  it("falls back to a live root key when the original key is revoked", async () => {
    const rec = emptyRec();
    const root = fakeKey({
      key_id: "k_root",
      prefix: "helm_live_root",
      role: "root",
      allow_custom_model: true,
    });
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: { ok: true },
      stream: null,
      error: null,
    });
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([fakeKey({ disabled: true }), root]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    expect(rec.inserts[0]?.apiKeyId).toBe("k_root");
  });

  it("skips DISABLED root keys when picking the fallback", async () => {
    const rec = emptyRec();
    const deadRoot = fakeKey({ key_id: "k_root_old", role: "root", disabled: true });
    const liveRoot = fakeKey({ key_id: "k_root_new", prefix: "helm_live_root2", role: "root" });
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: { ok: true },
      stream: null,
      error: null,
    });
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([deadRoot, liveRoot]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    expect(rec.inserts[0]?.apiKeyId).toBe("k_root_new");
  });

  it("409s only when the original key AND every root key are unavailable", async () => {
    // Empty store: nothing to route as.
    const recA = emptyRec();
    const missing = await runReplay(
      {
        replay: wiring(async () => ({}) as never, recA),
        telemetry: fakeTelemetry("key_1", recA),
        keyStore: fakeKeyStore([]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(409);
    expect(recA.routeCalls).toHaveLength(0);

    // Original revoked + the only root key revoked too: still blocked.
    const recB = emptyRec();
    const revoked = await runReplay(
      {
        replay: wiring(async () => ({}) as never, recB),
        telemetry: fakeTelemetry("key_1", recB),
        keyStore: fakeKeyStore([
          fakeKey({ disabled: true }),
          fakeKey({ key_id: "k_root", role: "root", disabled: true }),
        ]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.status).toBe(409);
    expect(recB.routeCalls).toHaveLength(0);
  });

  it("skips payload capture when capture_payloads is off (still records telemetry)", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: { ok: true },
      stream: null,
      error: null,
    });
    await runReplay(
      {
        replay: wiring(route, rec, { capturePayloads: () => false }),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(rec.payloads).toHaveLength(0);
    expect(rec.inserts).toHaveLength(1);
  });

  it("a per-key payload override captures on replay even when global mode is metadata-only", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: { ok: true },
      stream: null,
      error: null,
    });
    await runReplay(
      {
        replay: wiring(route, rec, { capturePayloads: () => false }),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([fakeKey({ request_content_mode: "payload" })]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );

    // The replayed key's explicit `payload` mode overrides global metadata-only.
    expect(rec.payloads).toHaveLength(1);
  });

  it("persists the partial stream + telemetry when the stream throws mid-drain", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: null,
      stream: sseThenThrow(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']),
      error: null,
    });
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      {
        originalTraceId: "orig",
        body: { ...okBody, stream: true },
        signal: new AbortController().signal,
        log: noop,
      },
    );
    // A mid-stream upstream failure must NOT abort persistence — the failed
    // retry stays viewable with whatever bytes arrived before the break.
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    expect(rec.payloads).toHaveLength(1);
    expect(rec.payloads[0]?.responseJson).toContain('"content":"partial"');
    expect(rec.inserts).toHaveLength(1);
  });

  it("500s when the telemetry insert fails (never returns an unviewable trace)", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: { ok: true },
      stream: null,
      error: null,
    });
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec, { failInsert: true }),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    // The detail page renders FROM the telemetry record — a swallowed insert
    // failure would navigate the UI to a 404. Fail the endpoint instead.
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(500);
  });

  it("still records a viewable trace when the provider call failed", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id, { status: "error" } as DecisionRecord["final"]),
      final: { status: "error" },
      body: null,
      stream: null,
      error: null,
    });
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    expect(rec.inserts).toHaveLength(1);
  });
});

// ── runReplay: non-OpenAI protocols (faithful native re-issue) ───────────────

describe("runReplay (anthropic_messages / openai_responses / gemini)", () => {
  it("anthropic_messages: preserves the top-level system prompt and records a native response", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: openAIResultBody("hello back"),
      stream: null,
      error: null,
    });
    const body = {
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      system: "You are terse.",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec, { original: storedDecision("anthropic_messages") }),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "orig", body, signal: new AbortController().signal, log: noop },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    const routed = rec.routeCalls[0]?.req;
    // Routed in the ANTHROPIC protocol …
    expect(routed?.protocol).toBe("anthropic_messages");
    // … with the top-level `system` HOISTED into a leading system message — the
    // fidelity the old openai_chat-only replay path silently dropped.
    expect(routed?.messages[0]).toEqual({ role: "system", content: "You are terse." });
    // The recorded response is NATIVE Anthropic (a `message` object), not OpenAI.
    const resp = JSON.parse(rec.payloads[0]?.responseJson ?? "{}");
    expect(resp.type).toBe("message");
    expect(rec.payloads[0]?.responseJson).toContain("hello back");
    expect(rec.inserts).toHaveLength(1);
  });

  it("openai_responses: re-issues the body and records a native Responses object", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: openAIResultBody(),
      stream: null,
      error: null,
    });
    const body = { model: "gpt-5.5", input: "say hi", max_output_tokens: 16 };
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec, { original: storedDecision("openai_responses") }),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "orig", body, signal: new AbortController().signal, log: noop },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    expect(rec.routeCalls[0]?.req.protocol).toBe("openai_responses");
    // Native Responses envelope (`object: "response"`), NOT the raw OpenAI body.
    const resp = JSON.parse(rec.payloads[0]?.responseJson ?? "{}");
    expect(resp.object).toBe("response");
    expect(resp.choices).toBeUndefined();
    expect(rec.payloads[0]?.responseJson).toContain("yo");
  });

  it("infers openai_responses from an input[] body when the protocol was not stored (legacy)", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: openAIResultBody(),
      stream: null,
      error: null,
    });
    const body = {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec), // no stored decision → infer from input[]
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "orig", body, signal: new AbortController().signal, log: noop },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    expect(rec.routeCalls[0]?.req.protocol).toBe("openai_responses");
  });

  it("gemini: recovers the model from the stored decision (the body has none) and records native", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "gemini/gemini-2.5-pro" },
      body: openAIResultBody(),
      stream: null,
      error: null,
    });
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec, {
          original: storedDecision("gemini", "gemini-2.5-pro"),
        }),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      { originalTraceId: "orig", body, signal: new AbortController().signal, log: noop },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    const routed = rec.routeCalls[0]?.req;
    expect(routed?.protocol).toBe("gemini");
    // The model rode the URL on the live request, so it is recovered from the
    // stored decision (not the body).
    expect(routed?.requested_model).toBe("gemini-2.5-pro");
    // Native Gemini response (a `candidates` array).
    const resp = JSON.parse(rec.payloads[0]?.responseJson ?? "{}");
    expect(Array.isArray(resp.candidates)).toBe(true);
  });

  it("400s on a structurally invalid native body (transformer throws), without recording", async () => {
    const rec = emptyRec();
    const out = await runReplay(
      {
        replay: wiring(async () => ({}) as never, rec),
        telemetry: fakeTelemetry("key_1", rec, { original: storedDecision("anthropic_messages") }),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      // Anthropic requires max_tokens + a non-empty messages array → transform throws.
      {
        originalTraceId: "orig",
        body: { messages: [] },
        signal: new AbortController().signal,
        log: noop,
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(400);
    expect(rec.routeCalls).toHaveLength(0);
    expect(rec.inserts).toHaveLength(0);
  });

  it("openai_responses streaming: captures the assembled NATIVE Responses SSE", async () => {
    const rec = emptyRec();
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: null,
      stream: sse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      ]),
      error: null,
    });
    const out = await runReplay(
      {
        replay: wiring(route, rec),
        telemetry: fakeTelemetry("key_1", rec, { original: storedDecision("openai_responses") }),
        keyStore: fakeKeyStore([fakeKey()]),
      },
      {
        originalTraceId: "orig",
        body: { model: "gpt-5.5", input: "hi", stream: true },
        signal: new AbortController().signal,
        log: noop,
      },
    );
    expect(out).toEqual({ ok: true, traceId: "new_trace" });
    // The captured body is the NATIVE Responses SSE event sequence (response.* events),
    // not raw OpenAI chat chunks.
    expect(rec.payloads[0]?.responseJson).toContain("event: response.");
    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]?.decision.usage).toEqual({
      measurement: "reported",
      cost_basis: null,
      prompt_tokens: 3,
      completion_tokens: 1,
      cached_tokens: null,
      cache_creation_tokens: null,
      service_tier: null,
      inference_geo: null,
      cache_creation_5m_tokens: null,
      cache_creation_1h_tokens: null,
      audio_prompt_tokens: null,
      cached_audio_prompt_tokens: null,
      image_output_tokens: null,
      billed_cost_usd: null,
    });
  });
});

// ── route ────────────────────────────────────────────────────────────────────

describe("registerReplayRoutes", () => {
  function appWith(replay: ReplayWiring | undefined, rec: Recorded) {
    const app = new Hono<AppEnv>();
    registerReplayRoutes(app, {
      keyStore: fakeKeyStore([fakeKey()]),
      telemetry: fakeTelemetry("key_1", rec),
      replay,
      // The route only touches keyStore/telemetry/replay; the rest of AdminApiDeps
      // is irrelevant here.
    } as never);
    return app;
  }

  it("POST returns { trace_id } for a captured request", async () => {
    const rec = emptyRec();
    const requestBody = JSON.stringify({ request: okBody }, null, 2);
    const route: ReplayWiring["route"] = async (req) => ({
      decision: decision(req.request_id),
      final: { status: "ok", alias: "openai/gpt-4" },
      body: { ok: true },
      stream: null,
      error: null,
    });
    const res = await appWith(wiring(route, rec), rec).request("/admin/api/requests/orig/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trace_id: "new_trace" });
    expect(rec.inserts[0]?.decision.request_body_bytes).toBe(
      Buffer.byteLength(requestBody, "utf8"),
    );
  });

  it("503s when replay is not wired", async () => {
    const res = await appWith(undefined, emptyRec()).request("/admin/api/requests/orig/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: okBody }),
    });
    expect(res.status).toBe(503);
  });

  it("400s when the body has no `request` field", async () => {
    const rec = emptyRec();
    const res = await appWith(
      wiring(async () => ({}) as never, rec),
      rec,
    ).request("/admin/api/requests/orig/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
