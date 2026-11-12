import {
  accumulateSpeechUsage,
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  createBlockedModelMatcher,
  MediaHttpError,
  type SpeechAccounting,
  SpeechAccountingError,
  type SpeechClient,
  type SpeechEvent,
  SpeechParameterError,
  speechMime,
  UpstreamError,
} from "@helm/core";
import {
  evaluateClientPolicy,
  type MediaPricing,
  MediaSpeechRequestSchema,
  type MediaSpeechUsage,
  type MediaSpendRecord,
} from "@helm/shared";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import type { ConcurrencyGatePort } from "../middleware/concurrency.js";
import { requestSignal } from "../middleware/limits.js";
import type { GeminiRateLimiterPort } from "./gemini.js";
import type { MessagesIdentity } from "./messages.js";

export interface SpeechSelection {
  pricing?: MediaPricing;
  client: Pick<SpeechClient, "ttsSpeech"> & Partial<SpeechClient>;
  model: string;
  alias: string;
  lane: string;
  /** True only for an explicit concrete-model override, never for a lane. */
  customModel: boolean;
}
export interface AudioSpeechRouteDeps {
  accounting?: SpeechAccounting;
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  resolve(
    model: string,
    identity: MessagesIdentity,
  ): SpeechSelection | null | Promise<SpeechSelection | null>;
  concurrencyGate: ConcurrencyGatePort;
  rateLimiter?: GeminiRateLimiterPort;
  budgetGate?: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  settleBudget?: (
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: null },
    nowMs: number,
  ) => Promise<void>;
  /** Host records redacted outcome and native usage; unknown spend stays null. */
  record?: (result: {
    identity: MessagesIdentity;
    selection: SpeechSelection;
    usage?: MediaSpeechUsage;
    status: "completed" | "error" | "canceled";
    traceId: string;
    costUsd?: number | null;
    operationId?: string;
  }) => Promise<void>;
}
export class SpeechAdmissionError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function admitSpeechIdentity(
  deps: Pick<AudioSpeechRouteDeps, "auth" | "budgetGate" | "rateLimiter">,
  credential: string | null,
  userAgent: string | null,
  canReserveSpend = false,
): Promise<MessagesIdentity> {
  const identity = await deps.auth.resolve(credential);
  if (!identity)
    throw new SpeechAdmissionError(401, "invalid_api_key", "missing or invalid API key");
  if (!evaluateClientPolicy(identity.caps?.clientPolicy, userAgent ?? undefined).allowed)
    throw new SpeechAdmissionError(
      403,
      "client_not_allowed",
      "This API key does not allow this client.",
    );
  const budget = identity.caps?.budget;
  if (budget?.weeklyAnchor != null && budget.tokens != null)
    throw new SpeechAdmissionError(
      422,
      "media_usage_unavailable",
      "speech token usage cannot be metered for this weekly-capped key",
    );
  if (budget?.spendUsd != null && !canReserveSpend)
    throw new SpeechAdmissionError(
      422,
      "media_pricing_unavailable",
      "speech pricing is unavailable for this spend-capped key",
    );
  if (
    budget &&
    (!deps.budgetGate ||
      (await deps.budgetGate.check({ keyId: identity.keyId, caps: budget, nowMs: Date.now() }))
        .overBudget)
  )
    throw new SpeechAdmissionError(429, "budget_exceeded", "usage budget unavailable or exceeded");
  if (deps.rateLimiter) {
    const result = await deps.rateLimiter.check({
      keyId: identity.keyId,
      estimatedTokens: 0,
      now: Date.now(),
      override: identity.caps?.rateLimit,
    });
    if (!result.allowed)
      throw new SpeechAdmissionError(429, "rate_limit_exceeded", "rate limit exceeded");
  }
  return identity;
}
export async function resolveSpeechSelection(
  deps: AudioSpeechRouteDeps,
  model: string,
  identity: MessagesIdentity,
): Promise<SpeechSelection> {
  const blocked = createBlockedModelMatcher(identity.caps?.blockedModels);
  if (blocked?.matches(model))
    throw new SpeechAdmissionError(403, "model_not_allowed", "speech model is blocked");
  const selection = await deps.resolve(model, identity);
  if (!selection)
    throw new SpeechAdmissionError(503, "provider_unavailable", "speech lane is unavailable");
  if (
    blocked?.matches(selection.alias) ||
    blocked?.matches(selection.model) ||
    blocked?.matches(selection.lane)
  )
    throw new SpeechAdmissionError(403, "model_not_allowed", "speech model is blocked");
  if (selection.customModel && identity.caps?.allowCustomModel !== true)
    throw new SpeechAdmissionError(
      403,
      "model_not_allowed",
      "custom speech models are not allowed",
    );
  const allowed = identity.caps?.allowedLanes;
  if (allowed && !allowed.includes(selection.lane))
    throw new SpeechAdmissionError(403, "lane_not_allowed", "speech lane is not allowed");
  return selection;
}
export async function acquireSpeechLease(
  deps: Pick<AudioSpeechRouteDeps, "concurrencyGate">,
  identity: MessagesIdentity,
  signal: AbortSignal,
) {
  const lease = await deps.concurrencyGate.acquire({
    keyId: identity.keyId,
    limit: identity.caps?.concurrencyLimit ?? null,
    signal,
  });
  if (!lease.ok)
    throw new SpeechAdmissionError(
      lease.reason === "unavailable" ? 503 : 429,
      "concurrency_limit",
      "speech concurrency lease unavailable",
    );
  const effectiveSignal = lease.signal ? AbortSignal.any([signal, lease.signal]) : signal;
  if (effectiveSignal.aborted) {
    await lease.release();
    throw new SpeechAdmissionError(
      499 as ContentfulStatusCode,
      "request_canceled",
      "speech request canceled",
    );
  }
  let released = false;
  return {
    signal: effectiveSignal,
    release: async () => {
      if (released) return;
      released = true;
      await lease.release();
    },
  };
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new SpeechAdmissionError(400, "invalid_request", "missing speech body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024)
        throw new SpeechAdmissionError(413, "request_too_large", "speech request too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function registerAudioSpeechRoute(app: Hono<AppEnv>, deps: AudioSpeechRouteDeps): void {
  app.get("/v1/audio/operations/:id", async (c) => {
    const identity = await deps.auth.resolve(
      /^Bearer\s+(.+)$/.exec(c.req.header("Authorization") ?? "")?.[1] ?? null,
    );
    if (!identity) return c.json({ error: { code: "invalid_api_key" } }, 401);
    if (!evaluateClientPolicy(identity.caps?.clientPolicy, c.req.header("user-agent")).allowed)
      return c.json({ error: { code: "client_not_allowed" } }, 403);
    if (!deps.accounting) return c.json({ error: { code: "media_accounting_unavailable" } }, 503);
    const record = await deps.accounting.get(c.req.param("id"), identity.keyId);
    if (!record) return c.json({ error: { code: "operation_not_found" } }, 404);
    return c.json(
      {
        operationId: record.id,
        state: record.state,
        providerAlias: record.alias,
        reservedUsd: record.reservedUsd,
        costUsd: record.costUsd,
        costBasis: "list_price",
        usage: record.usage,
      },
      200,
      { "cache-control": "no-store" },
    );
  });
  app.post("/v1/audio/speech", async (c) => {
    let lease: Awaited<ReturnType<typeof acquireSpeechLease>> | undefined;
    let handedOff = false;
    const abort = new AbortController();
    let spend: MediaSpendRecord | undefined;
    try {
      const identity = await admitSpeechIdentity(
        deps,
        /^Bearer\s+(.+)$/.exec(c.req.header("Authorization") ?? "")?.[1] ?? null,
        c.req.header("user-agent") ?? null,
        !!deps.accounting,
      );
      const parsed = MediaSpeechRequestSchema.safeParse(await readBody(c.req.raw));
      if (!parsed.success)
        throw new SpeechAdmissionError(
          400,
          "invalid_request",
          "invalid or unsupported speech parameters",
        );
      if (
        (parsed.data.timestamps && parsed.data.output !== "json") ||
        (parsed.data.stream && parsed.data.output === "json")
      )
        throw new SpeechAdmissionError(
          422,
          "unsupported_parameter",
          "timestamps require non-streaming JSON output; use WebSocket for timestamp events",
        );
      const selection = await resolveSpeechSelection(deps, parsed.data.model, identity);
      const req = { ...parsed.data, model: selection.model };
      lease = await acquireSpeechLease(
        deps,
        identity,
        AbortSignal.any([requestSignal(c), abort.signal, AbortSignal.timeout(120_000)]),
      );
      if (req.stream && !selection.client.streamSpeech)
        throw new SpeechAdmissionError(
          422,
          "unsupported_parameter",
          "streaming is unavailable for this lane",
        );
      const activeLease = lease;
      const traceId = c.get("trace_id") ?? crypto.randomUUID();
      if (deps.accounting)
        spend = await deps.accounting.reserve({
          id: crypto.randomUUID(),
          keyId: identity.keyId,
          alias: selection.alias,
          model: selection.model,
          pricing: selection.pricing,
          caps: identity.caps?.budget,
          request: req,
        });
      let recorded = false;
      let onStreamAbort: (() => void) | undefined;
      const finish = async (
        status: "completed" | "error" | "canceled",
        usage?: MediaSpeechUsage,
        notSent = false,
      ) => {
        if (recorded) return;
        recorded = true;
        if (onStreamAbort) activeLease.signal.removeEventListener("abort", onStreamAbort);
        try {
          if (spend && deps.accounting)
            spend =
              (await deps.accounting.settle(
                spend,
                selection.pricing,
                usage,
                status === "completed",
                notSent,
              )) ?? spend;
          if (identity.caps?.budget && deps.settleBudget)
            await deps.settleBudget(
              identity.keyId,
              spend ? { ...identity.caps.budget, spendUsd: null } : identity.caps.budget,
              { requests: 1, tokens: 0, costUsd: null },
              Date.now(),
            );
          await deps.record?.({
            identity,
            selection,
            usage,
            status,
            traceId,
            costUsd: spend?.costUsd,
            operationId: spend?.id,
          });
        } catch {
          c.get("logger")?.log("error", "media.speech_accounting_failed", { trace_id: traceId });
        } finally {
          await activeLease.release();
        }
      };
      if (!req.stream) {
        try {
          const result = await selection.client.ttsSpeech(req, { signal: lease.signal });
          await finish("completed", result.usage);
          const accounting = spend
            ? {
                operationId: spend.id,
                state: spend.state,
                reservedUsd: spend.reservedUsd,
                costUsd: spend.costUsd,
                costBasis: "list_price",
              }
            : undefined;
          if (req.output === "json")
            return c.json(
              { ...result, audio: Buffer.from(result.audio).toString("base64"), accounting },
              200,
              {
                "cache-control": "no-store",
              },
            );
          return new Response(result.audio as Uint8Array<ArrayBuffer>, {
            headers: {
              "content-type": result.contentType,
              "cache-control": "no-store",
              ...(spend ? { "x-helm-media-operation-id": spend.id } : {}),
            },
          });
        } catch (error) {
          await finish(
            lease.signal.aborted ? "canceled" : "error",
            undefined,
            error instanceof SpeechParameterError ||
              (error instanceof MediaHttpError && error.outcome !== "unknown") ||
              (error instanceof UpstreamError &&
                [400, 401, 402, 403, 404, 413, 422, 429].includes(error.upstreamStatus ?? 0)),
          );
          throw error;
        }
      }
      if (!selection.client.streamSpeech)
        throw new SpeechAdmissionError(
          422,
          "unsupported_parameter",
          "streaming is unavailable for this lane",
        );
      const iterator = selection.client
        .streamSpeech(req, { signal: lease.signal })
        [Symbol.asyncIterator]();
      let usage: MediaSpeechUsage | undefined;
      async function nextAudio(): Promise<Uint8Array | null> {
        for (;;) {
          const next = await iterator.next();
          if (next.done) throw new Error("speech stream ended before completion");
          const event: SpeechEvent = next.value;
          if (event.type === "usage") usage = accumulateSpeechUsage(usage, event.usage);
          if (event.type === "audio") return event.audio;
          if (event.type === "error") throw new Error("speech upstream failed");
          if (event.type === "completed") {
            await iterator.return?.();
            await finish("completed", usage);
            return null;
          }
        }
      }
      let first: Uint8Array | null;
      try {
        first = await nextAudio();
      } catch (error) {
        await iterator.return?.();
        await finish("error", usage);
        throw error;
      }
      if (!first)
        throw new SpeechAdmissionError(502, "upstream_error", "speech completed without audio");
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      onStreamAbort = () => {
        first = null;
        try {
          streamController.error(new Error("speech stream aborted"));
        } catch {}
        void iterator.return?.().catch(() => {});
        void finish("canceled", usage).catch(() => {});
      };
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller;
          },
          async pull(controller) {
            try {
              const audio = first ?? (await nextAudio());
              first = null;
              if (audio) controller.enqueue(audio);
              else controller.close();
            } catch {
              const finishing = finish("error", usage);
              abort.abort();
              await iterator.return?.();
              await finishing;
              controller.error(new Error("speech stream interrupted"));
            }
          },
          async cancel() {
            abort.abort();
            await iterator.return?.();
            await finish("canceled", usage);
          },
        },
        { highWaterMark: 0 },
      );
      activeLease.signal.addEventListener("abort", onStreamAbort, { once: true });
      if (activeLease.signal.aborted) onStreamAbort();
      handedOff = true;
      return new Response(stream, {
        headers: {
          "content-type": speechMime(req.response_format),
          "cache-control": "no-store",
          ...(spend ? { "x-helm-media-operation-id": spend.id } : {}),
        },
      });
    } catch (caught) {
      const error =
        caught instanceof SpeechAccountingError
          ? new SpeechAdmissionError(
              caught.code === "budget_exceeded"
                ? 429
                : caught.code === "media_pricing_unavailable"
                  ? 422
                  : 503,
              caught.code,
              caught.message,
            )
          : caught instanceof SpeechParameterError
            ? new SpeechAdmissionError(422, "unsupported_parameter", caught.message)
            : caught;
      const known = error instanceof SpeechAdmissionError;
      return c.json(
        {
          error: {
            message: known ? error.message : "speech request failed",
            ...(spend ? { operation_id: spend.id } : {}),
            type: known ? "invalid_request_error" : "upstream_error",
            code: known ? error.code : spend ? "outcome_unknown" : "upstream_error",
            param: null,
          },
        },
        known
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : error instanceof UpstreamError
              ? (error.httpStatus as ContentfulStatusCode)
              : 502,
      );
    } finally {
      if (!handedOff) {
        abort.abort();
        await lease?.release();
      }
    }
  });
}
