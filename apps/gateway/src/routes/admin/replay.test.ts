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
  opts: { failInsert?: boolean } = {},
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
    async getByRequestId() {
      return null;
    },
    async queryWindow() {
      return [];
    },
    async getPayload() {
      return null;
    },
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
    payloadRetentionMs: () => 0,
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
      keyCaps: { allowedLanes: null, degradeLane: null },
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

  it("409s when the original key was deleted or revoked", async () => {
    const recA = emptyRec();
    const missing = await runReplay(
      {
        replay: wiring(async () => ({}) as never, recA),
        telemetry: fakeTelemetry("key_1", recA),
        keyStore: fakeKeyStore([]), // deleted
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(409);

    const recB = emptyRec();
    const revoked = await runReplay(
      {
        replay: wiring(async () => ({}) as never, recB),
        telemetry: fakeTelemetry("key_1", recB),
        keyStore: fakeKeyStore([fakeKey({ disabled: true })]),
      },
      { originalTraceId: "orig", body: okBody, signal: new AbortController().signal, log: noop },
    );
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.status).toBe(409);
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
      body: JSON.stringify({ request: okBody }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trace_id: "new_trace" });
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
