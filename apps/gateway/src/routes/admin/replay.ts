import {
  anthropicTransformer,
  geminiTransformer,
  type IRResponse,
  type KeyStore,
  responsesTransformer,
  type TelemetryStore,
} from "@helm/core";
import {
  type ApiKeyRecord,
  type DecisionRecord,
  type InternalRequest,
  type OpenAIChatRequest,
  OpenAIChatRequestSchema,
  type Protocol,
} from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import { copyLiteLLMRequestParams, providerRawFromRequest } from "../internal-request-params.js";
import type { MessagesIdentity, PipelineRunResult } from "../messages.js";
import { createMessagesPipeline, PipelineError } from "../messages-pipeline.js";
import {
  backfillCompletionCost,
  type PayloadCaptureDeps,
  persistPayload,
  usageFromSSE,
} from "../payload-capture.js";
import type { AdminApiDeps, ReplayWiring } from "./deps.js";

// /admin/api/requests/:traceId/replay — the admin "Retry" surface (behind the
// admin Basic auth, like every /admin/api/* route). Re-issues a recorded request
// (optionally EDITED by the operator — e.g. a higher max_tokens) through the SAME
// routing core a live call uses, records a NEW trace + payload, and returns its id
// so the SPA can navigate to it.
//
// It is an ISOLATED debug re-run (Principle 3 + the operator's choice): no usage
// budget is charged and no conversation memory is written/injected. Identity +
// caps are reconstructed from the ORIGINAL request's key so routing (lane
// whitelist / allow_custom_model) is faithful. When that key is gone (deleted or
// revoked), the replay FALLS BACK to a live root key instead of refusing: the
// operator behind the admin Basic auth already holds root-equivalent power, and
// what they want from a retry is the RESULT — a 409 tells them nothing. The
// trade-off is routing fidelity (root caps, no lane whitelist), so the fallback
// is logged and the new trace is attributed to the key ACTUALLY used. Only when
// no live root key exists either does the replay 409.
//
// DELIBERATE BYPASSES (debug, not client traffic): besides the budget gate/settle
// and memory, a replay also skips the per-key RATE LIMIT (rate_limit_rpm/tpm) and
// CONCURRENCY gate — those middlewares guard the /v1 client surface; a replay is
// a one-off OPERATOR action behind the admin Basic auth (the dialog's `sending`
// state serializes clicks). It is one manual upstream call, not a quota bypass
// vector — an operator who can replay can already call the upstream directly.

interface RunReplayDeps {
  replay: ReplayWiring;
  telemetry: TelemetryStore;
  keyStore: KeyStore;
}

// Discriminated outcome so the route maps to a status without exception control
// flow (and unit tests assert without try/catch).
export type RunReplayOutcome =
  | { ok: true; traceId: string }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export async function runReplay(
  deps: RunReplayDeps,
  args: {
    originalTraceId: string;
    body: unknown;
    signal: AbortSignal;
    log: (msg: string) => void;
  },
): Promise<RunReplayOutcome> {
  // 1. Recover the ORIGINAL request's redacted DecisionRecord (by trace id). Since
  //    the protocol-aware build it carries the client `protocol`, so the replay can
  //    re-issue in the request's NATIVE shape (not just OpenAI chat); it also carries
  //    `requested_model`, which the Gemini body lacks (Gemini's model rides the URL).
  //    FAIL-OPEN: a read miss falls back to body-shape inference.
  const original = await deps.telemetry.getByRequestId(args.originalTraceId).catch(() => null);
  const protocol: Protocol = original?.protocol ?? inferProtocol(args.body);

  // 2. Resolve the ORIGINAL request's key_id. It lives in a separate telemetry
  //    column (the redacted DecisionRecord carries only key_prefix), so the
  //    narrow lookup surfaces it. Absent → the request is unknown/pruned.
  const keyId = await deps.telemetry.getApiKeyId(args.originalTraceId);
  if (keyId === null) return { ok: false, status: 404, error: "original request not found" };

  // 3. Reconstruct identity from the still-live key so the re-run routes with the
  //    SAME caps. If the original key is gone (deleted or revoked), fall back to a
  //    live root key — see the header comment for why this is the operator's
  //    deliberate choice, not a permission leak. 409 only when neither exists.
  const keys = await deps.keyStore.list();
  const originalKey = keys.find((k) => k.key_id === keyId);
  let key: ApiKeyRecord;
  if (originalKey && !originalKey.disabled) {
    key = originalKey;
  } else {
    const root = keys.find((k) => k.role === "root" && !k.disabled);
    if (!root) {
      return {
        ok: false,
        status: 409,
        error: "original key is unavailable (deleted or revoked) and no active root key exists",
      };
    }
    key = root;
    args.log("replay.root_key_fallback");
  }

  // 4. Build + route the re-run under a NEW trace id, in the ORIGINAL protocol.
  //    openai_chat re-issues through the chat path (a direct InternalRequest); the
  //    other three re-issue through the SAME createMessagesPipeline the live
  //    /v1/messages, /v1/responses and :generateContent routes use (inbound
  //    transform → route → native outbound), so the recorded re-run matches a real
  //    request of that protocol. Both paths force memory OFF + no budget (isolated
  //    debug re-run). A bad body → 400; a routing failure still records a viewable
  //    (failed) trace.
  const traceId = deps.replay.genTraceId();
  const prepared =
    protocol === "openai_chat"
      ? await replayOpenAIChat(deps, args, key, traceId)
      : await replayViaPipeline(deps, args, key, traceId, protocol, original);
  if (!prepared.ok) return prepared;

  // 5. Persist payload + telemetry under the NEW id. Isolated: NO budget settle,
  //    NO memory observe, NO OAuth-usage record. A provider failure still records
  //    a decision (the error trail) so even a failed retry is viewable. Payload
  //    capture stays fail-open (like the live routes); the telemetry insert is
  //    fail-CLOSED — see below.
  const captureDeps: PayloadCaptureDeps = {
    telemetry: deps.telemetry,
    capturePayloads: deps.replay.capturePayloads,
    payloadRetentionMs: deps.replay.payloadRetentionMs,
    costOf: deps.replay.costOf,
  };
  await persistPayload(
    captureDeps,
    {
      requestId: traceId,
      requestJson: prepared.requestJson,
      responseJson: prepared.responseJson,
      now: deps.replay.now(),
    },
    args.log,
  );
  // UNLIKE the live routes (where telemetry is fail-open so a logging hiccup
  // never 5xx's a served client request), the replay's WHOLE deliverable is the
  // recorded trace — the UI navigates straight to it. A swallowed insert failure
  // would return a trace id that 404s, so here the insert is part of the
  // contract: fail the endpoint instead.
  try {
    await deps.telemetry.insert({
      decision: deps.replay.redact(prepared.decision) as DecisionRecord,
      // Attribute the NEW trace to the key ACTUALLY used — on a root-key
      // fallback that is the root key, not the dead original (honest audit
      // trail, no dangling key_id reference).
      apiKeyId: key.key_id,
      createdAt: new Date(deps.replay.now()),
    });
  } catch {
    args.log("replay.telemetry_insert_failed");
    return {
      ok: false,
      status: 500,
      error: "replay executed but recording its result failed — check gateway logs",
    };
  }

  return { ok: true, traceId };
}

// A built + routed replay ready to persist, or a 400 the route surfaces verbatim
// (the build/transform rejected the edited body). Carries the LIVE decision the
// stream branch may have mutated (cost backfill) before it is recorded.
type PreparedReplay =
  | { ok: true; decision: DecisionRecord; requestJson: string; responseJson: string | null }
  | { ok: false; status: 400; error: string };

// Protocol inference for LEGACY records (no stored protocol): the Responses body
// carries `input[]`, Gemini carries `contents[]`; anything else (the OpenAI/
// Anthropic `messages[]` shape, or an unknown body) defaults to openai_chat — the
// only shape the pre-protocol replay understood, so behavior on OLD records is
// unchanged. NEW records always carry the exact protocol on the DecisionRecord.
function inferProtocol(body: unknown): Protocol {
  const b = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(b.input)) return "openai_responses";
  if (Array.isArray(b.contents)) return "gemini";
  return "openai_chat";
}

// openai_chat re-issue: validate the (edited) OpenAI body, map it to an
// InternalRequest, route, and consume the OpenAI-shaped result (mirrors chat.ts).
async function replayOpenAIChat(
  deps: RunReplayDeps,
  args: { body: unknown; signal: AbortSignal; log: (msg: string) => void },
  key: ApiKeyRecord,
  traceId: string,
): Promise<PreparedReplay> {
  // Boundary guard (fail-closed, principle 2): a non-OpenAI shape is rejected here.
  const parsed = OpenAIChatRequestSchema.safeParse(args.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, status: 400, error: `${where}${issue?.message ?? "invalid request body"}` };
  }
  const internal = buildInternal(parsed.data, traceId, key);
  const result = await deps.replay.route(
    internal,
    {
      allowCustomModel: key.allow_custom_model,
      keyPrefix: key.prefix,
      keyCaps: { allowedLanes: key.allowed_lanes, degradeLane: null },
    },
    args.signal,
  );

  const finalAlias =
    result.decision.final.status === "ok" ? result.decision.final.model_alias : null;
  let responseJson: string | null;
  if (internal.stream && result.stream !== null) {
    const captured: string[] = [];
    // Drain inside a catch: a mid-stream upstream failure must NOT abort the
    // persistence — the failed retry stays viewable with the bytes that arrived.
    try {
      for await (const chunk of result.stream) captured.push(chunk);
    } catch {
      args.log("replay.stream_failed");
    }
    const rawSse = captured.join("");
    responseJson = rawSse;
    // Streamed completion-cost backfill — identical to the live chat path: the
    // cost is unknown at peek time, so price the trailing usage tail here.
    try {
      const usage = usageFromSSE(rawSse);
      if (usage) {
        // Token stamp needs no pricing — land it whenever the tail has usage;
        // price the cost only when costOf is wired (identical to the live path).
        const cost =
          finalAlias && deps.replay.costOf ? deps.replay.costOf(finalAlias, usage) : null;
        backfillCompletionCost(result.decision, finalAlias, cost, usage);
      }
    } catch {
      args.log("replay.cost_backfill_failed");
    }
  } else {
    responseJson = result.body !== null ? JSON.stringify(result.body) : null;
  }
  return {
    ok: true,
    decision: result.decision,
    requestJson: JSON.stringify(parsed.data),
    responseJson,
  };
}

// Inbound/outbound translators per non-chat protocol — the SAME singletons the
// live routes use, so the replay's translation is byte-identical (incl. the
// Anthropic top-level `system` hoist + tool reshaping that the openai_chat path
// silently dropped). Gemini stream events are full snapshots with no event name,
// so they serialize as nameless `data:` frames (docs/05); Anthropic/Responses
// events carry an SSE event name.
const PIPELINE_ADAPTERS: Record<
  Exclude<Protocol, "openai_chat">,
  {
    transformRequestOut: (native: unknown) => unknown | Promise<unknown>;
    transformResponseOut: (ir: unknown) => unknown | Promise<unknown>;
    serializeStreamEvent: (event: Record<string, unknown>) => string;
  }
> = {
  anthropic_messages: {
    transformRequestOut: (n) => anthropicTransformer.transformRequestOut(n),
    transformResponseOut: (ir) => anthropicTransformer.transformResponseOut(ir as IRResponse),
    // The pipeline already produced the typed Anthropic SSE events; serialize ONE
    // into its wire event/data pair (event = the event's `type`), exactly as the
    // live /v1/messages route does.
    serializeStreamEvent: (e) => `event: ${String(e.type ?? "")}\ndata: ${JSON.stringify(e)}\n\n`,
  },
  openai_responses: {
    transformRequestOut: (n) => responsesTransformer.transformRequestOut(n),
    transformResponseOut: (ir) => responsesTransformer.transformResponseOut(ir as IRResponse),
    serializeStreamEvent: (e) => `event: ${String(e.type ?? "")}\ndata: ${JSON.stringify(e)}\n\n`,
  },
  gemini: {
    transformRequestOut: (n) => geminiTransformer.transformRequestOut(n),
    transformResponseOut: (ir) => geminiTransformer.transformResponseOut(ir as IRResponse),
    serializeStreamEvent: (e) => `data: ${JSON.stringify(e)}\n\n`,
  },
};

// The loose IR the inbound transformers produce — the pipeline reads `stream` to
// branch and stamps trace_id onto `metadata`; the rest is opaque (the route's
// IRLike contract).
type ReplayIR = {
  metadata?: Record<string, unknown>;
  stream?: boolean;
  model?: unknown;
  [k: string]: unknown;
};

// anthropic_messages / openai_responses / gemini re-issue: transform the native
// (edited) body to IR, route it through the SHARED pipeline (no memory/budget),
// and capture the NATIVE-shaped response — exactly what the live route records.
async function replayViaPipeline(
  deps: RunReplayDeps,
  args: { body: unknown; signal: AbortSignal; log: (msg: string) => void },
  key: ApiKeyRecord,
  traceId: string,
  protocol: Exclude<Protocol, "openai_chat">,
  original: DecisionRecord | null,
): Promise<PreparedReplay> {
  const adapter = PIPELINE_ADAPTERS[protocol];
  // Inbound: native body → IR. The real transformer Zod-validates and THROWS on a
  // structurally invalid body — map it to 400 (fail-closed), like the live route.
  let ir: ReplayIR;
  try {
    ir = (await adapter.transformRequestOut(args.body)) as ReplayIR;
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : "invalid request",
    };
  }
  // Stamp the NEW trace id; no memory headers → scope defaults OFF (isolated re-run).
  ir.metadata = { ...(ir.metadata ?? {}), trace_id: traceId };
  // Gemini's model + stream-ness ride the URL, not the body, so the captured body
  // carries neither: recover the model from the original decision (else "auto" =
  // re-classify) and replay NON-stream (a debug re-run wants the full response).
  if (protocol === "gemini") {
    ir.model =
      original?.requested_model && original.requested_model.length > 0
        ? original.requested_model
        : "auto";
    ir.stream = false;
  }

  const identity: MessagesIdentity = {
    keyId: key.key_id,
    accountId: key.account_id,
    keyPrefix: key.prefix,
    // Faithful routing caps; NO budget block → the pipeline's budget gate/settle
    // is a no-op (it is also unwired below), so the replay never charges usage.
    caps: { allowCustomModel: key.allow_custom_model, allowedLanes: key.allowed_lanes },
  };

  // The SAME routing core as the live face — but with NO memory / budget /
  // oauth-usage / write-queue wiring: an isolated re-run that never writes memory
  // nor settles a budget.
  const pipeline = createMessagesPipeline(deps.replay.route, protocol);
  let result: PipelineRunResult;
  try {
    result = await pipeline.run(ir, identity, args.signal);
  } catch (err) {
    // run() throws PipelineError(invalid_request) for an empty request (pre-route).
    if (err instanceof PipelineError) return { ok: false, status: 400, error: err.message };
    throw err;
  }

  // Consume into a NATIVE-shaped capturable body. A routing failure (all providers
  // failed) throws across the accessor seam — the failed retry still records
  // (responseJson null / partial), matching the openai_chat path. Streamed
  // completion-cost backfill is intentionally absent (the pipeline only backfills
  // when budget deps are wired, which a replay omits — documented limitation).
  let responseJson: string | null = null;
  if (ir.stream === true) {
    const captured: string[] = [];
    try {
      for await (const event of result.streamIR())
        captured.push(adapter.serializeStreamEvent(event));
    } catch {
      args.log("replay.stream_failed");
    }
    responseJson = captured.length > 0 ? captured.join("") : null;
  } else {
    try {
      responseJson = JSON.stringify(await adapter.transformResponseOut(await result.collect()));
    } catch (err) {
      if (!(err instanceof PipelineError)) throw err;
      args.log("replay.route_failed");
    }
  }
  return {
    ok: true,
    decision: result.decision,
    requestJson: JSON.stringify(args.body),
    responseJson,
  };
}

// Map the (validated) OpenAI chat body → InternalRequest for the replay. Mirrors
// the live route's `toInternalRequest` (chat.ts) MINUS memory/session: the loose
// passthrough fields (tools/response_format/max_tokens) are read off the body bag,
// identity comes from the reconstructed key, and memory is forced off.
function buildInternal(
  body: OpenAIChatRequest,
  traceId: string,
  key: ApiKeyRecord,
): InternalRequest {
  const bag = body as Record<string, unknown>;
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : "auto";
  const providerRaw = providerRawFromRequest(bag);
  return {
    request_id: traceId,
    protocol: "openai_chat",
    account_id: key.account_id,
    api_key_id: key.key_id,
    user_id: null,
    org_id: null,
    requested_model: model,
    messages: body.messages as InternalRequest["messages"],
    tools: Array.isArray(bag.tools) ? (bag.tools as unknown[]) : null,
    response_format:
      bag.response_format && typeof bag.response_format === "object"
        ? (bag.response_format as Record<string, unknown>)
        : null,
    attachments: null,
    max_tokens: typeof bag.max_tokens === "number" ? bag.max_tokens : null,
    ...copyLiteLLMRequestParams(bag),
    ...(providerRaw !== undefined ? { provider_raw: providerRaw } : {}),
    stream: body.stream === true,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
  };
}

export function registerReplayRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // POST /requests/:traceId/replay  body: { request: <openai chat body> } ->
  // { trace_id } | { error } (400 bad body, 404 unknown request, 409 original
  // key gone AND no live root key, 500 result not recorded, 503 replay not wired).
  app.post("/admin/api/requests/:traceId/replay", async (c) => {
    if (deps.replay === undefined) return c.json({ error: "replay not available" }, 503);
    const originalTraceId = c.req.param("traceId");
    const raw = (await c.req.json().catch(() => null)) as { request?: unknown } | null;
    if (raw === null || typeof raw !== "object" || !("request" in raw)) {
      return c.json({ error: "missing request body" }, 400);
    }
    const log = (msg: string): void => {
      try {
        c.get("logger")?.log("warn", msg, { trace_id: originalTraceId });
      } catch {
        // logger absent (unit harness) — drop the diagnostic, never fail the route.
      }
    };
    const outcome = await runReplay(
      { replay: deps.replay, telemetry: deps.telemetry, keyStore: deps.keyStore },
      { originalTraceId, body: raw.request, signal: c.req.raw.signal, log },
    );
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    return c.json({ trace_id: outcome.traceId });
  });
}
