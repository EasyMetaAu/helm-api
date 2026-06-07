import type { KeyStore, TelemetryStore } from "@helm/core";
import {
  type ApiKeyRecord,
  type DecisionRecord,
  type InternalRequest,
  type OpenAIChatRequest,
  OpenAIChatRequestSchema,
} from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
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
  // 1. Validate the (possibly edited) body as a well-formed OpenAI chat request —
  //    same boundary guard as the live route (fail-closed, principle 2). v1 scope:
  //    openai_chat only; a non-OpenAI shape is rejected here.
  const parsed = OpenAIChatRequestSchema.safeParse(args.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, status: 400, error: `${where}${issue?.message ?? "invalid request body"}` };
  }

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
  const original = keys.find((k) => k.key_id === keyId);
  let key: ApiKeyRecord;
  if (original && !original.disabled) {
    key = original;
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

  // 4. Build a fresh InternalRequest under a NEW trace id. Memory OFF + no session
  //    momentum: an isolated debug re-run must not write/inject conversation memory.
  const traceId = deps.replay.genTraceId();
  const internal = buildInternal(parsed.data, traceId, key);

  // 5. Route through the SAME core pipeline as a live call — but with NO budget
  //    gate/degrade (degradeLane null). The key's lane whitelist + custom-model
  //    cap still apply (faithful routing).
  const result = await deps.replay.route(
    internal,
    {
      allowCustomModel: key.allow_custom_model,
      keyPrefix: key.prefix,
      keyCaps: { allowedLanes: key.allowed_lanes, degradeLane: null },
    },
    args.signal,
  );

  // 6. Consume the outcome server-side (there is no client to forward to) into a
  //    capturable response body, mirroring the chat route's two branches.
  const finalAlias =
    result.decision.final.status === "ok" ? result.decision.final.model_alias : null;
  let responseJson: string | null;
  if (internal.stream && result.stream !== null) {
    const captured: string[] = [];
    // Drain inside a catch: a mid-stream upstream failure must NOT abort the
    // persistence below — the failed retry stays viewable with whatever bytes
    // arrived before the break (mirrors the live stream branch's finally).
    try {
      for await (const chunk of result.stream) captured.push(chunk);
    } catch {
      args.log("replay.stream_failed");
    }
    const rawSse = captured.join("");
    responseJson = rawSse;
    // Streamed completion-cost backfill (#6) — identical to the live chat path:
    // the cost is unknown at peek time, so price the trailing usage tail here.
    try {
      const usage = usageFromSSE(rawSse);
      if (usage && finalAlias && deps.replay.costOf) {
        backfillCompletionCost(result.decision, finalAlias, deps.replay.costOf(finalAlias, usage));
      }
    } catch {
      args.log("replay.cost_backfill_failed");
    }
  } else {
    responseJson = result.body !== null ? JSON.stringify(result.body) : null;
  }

  // 7. Persist payload + telemetry under the NEW id. Isolated: NO budget settle,
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
      requestJson: JSON.stringify(parsed.data),
      responseJson,
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
      decision: deps.replay.redact(result.decision) as DecisionRecord,
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
