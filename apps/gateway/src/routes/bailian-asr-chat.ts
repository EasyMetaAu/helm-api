import {
  createBlockedModelMatcher,
  MediaHttpError,
  type ProviderClient,
  parseBailianShortAsrRequest,
  pcmWavDurationSeconds,
  SpeechAccountingError,
  type TranscriptionAccounting,
} from "@helm/core";
import type { AudioTranscriptionResult, MediaPricing, MediaSpendRecord } from "@helm/shared";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { requestSignal } from "../middleware/limits.js";
import type { AudioSpeechRouteDeps } from "./audio-speech.js";
export interface ShortAsrTarget {
  client: Pick<ProviderClient, "chatCompletion" | "chatCompletionStream"> | null;
  alias: string;
  model: string;
  lane: string;
  customModel: boolean;
  pricing?: MediaPricing;
}
export interface ShortAsrDeps extends Pick<AudioSpeechRouteDeps, "budgetGate" | "settleBudget"> {
  resolve(model: string): ShortAsrTarget | null;
  accounting?: TranscriptionAccounting;
  record?(
    target: ShortAsrTarget,
    keyId: string,
    traceId: string,
    status: "ok" | "error",
    spend?: MediaSpendRecord,
  ): Promise<void>;
}
const NativeDuration = z.object({
  usage: z.object({ seconds: z.number().finite().nonnegative() }),
});

/** Called after the existing Chat auth, rate, concurrency and bounded body middleware. */
export async function handleBailianAsrChat(
  c: Context<AppEnv>,
  raw: unknown,
  deps: ShortAsrDeps,
): Promise<Response | null> {
  if (!raw || typeof raw !== "object" || !("model" in raw) || typeof raw.model !== "string")
    return null;
  const target = deps.resolve(raw.model);
  if (!target) return null;
  const identity = c.get("identity");
  let spend: MediaSpendRecord | undefined;
  const fail = (status: 400 | 403 | 422 | 429 | 502 | 503, code: string) =>
    c.json(
      {
        error: {
          type: "api_error",
          code,
          message: code.replaceAll("_", " "),
          ...(spend ? { operation_id: spend.id } : {}),
        },
      },
      status,
    );
  const client = target.client;
  if (!client) return fail(503, "provider_unavailable");
  const caps = identity.caps,
    blocked = createBlockedModelMatcher(caps?.blockedModels);
  if ([raw.model, target.alias, target.model, target.lane].some((m) => blocked?.matches(m)))
    return fail(403, "model_not_allowed");
  if (target.customModel && caps?.allowCustomModel !== true) return fail(403, "model_not_allowed");
  if (caps?.allowedLanes && !caps.allowedLanes.includes(target.lane))
    return fail(403, "lane_not_allowed");
  const budget = caps?.budget;
  if (budget?.weeklyAnchor != null && budget.tokens != null)
    return fail(422, "media_usage_unavailable");
  const spendCapped = budget?.spendUsd != null;
  // This slice meters completed short WAV requests, not streaming or remote URL audio.
  if (spendCapped && (!deps.accounting || ("stream" in raw && raw.stream === true)))
    return fail(422, "media_pricing_unavailable");
  if (
    budget &&
    (!deps.budgetGate ||
      (await deps.budgetGate.check({ keyId: identity.keyId, caps: budget, nowMs: Date.now() }))
        .overBudget)
  )
    return fail(429, "budget_exceeded");
  let body: ReturnType<typeof parseBailianShortAsrRequest>;
  try {
    body = parseBailianShortAsrRequest({ ...raw, model: target.model });
  } catch {
    return fail(400, "invalid_asr_request");
  }
  const signal = requestSignal(c);
  signal.throwIfAborted();
  if (!body.stream && deps.accounting) {
    const message = body.messages.at(-1);
    const data = message?.role === "user" ? message.content[0]?.input_audio.data : undefined;
    const bytes = data?.startsWith("data:audio/")
      ? Buffer.from(data.slice(data.indexOf(",") + 1), "base64")
      : undefined;
    const file =
      bytes && pcmWavDurationSeconds(bytes) !== null
        ? new File([bytes], "short-asr.wav", { type: "audio/wav" })
        : undefined;
    if (spendCapped && !file) return fail(422, "media_pricing_unavailable");
    if (file) {
      try {
        spend = await deps.accounting.reserve({
          id: crypto.randomUUID(),
          keyId: identity.keyId,
          alias: target.alias,
          model: target.model,
          pricing: target.pricing,
          caps: budget,
          file,
          request: { model: target.model },
        });
        c.header("x-helm-media-operation-id", spend.id);
      } catch (error) {
        if (error instanceof SpeechAccountingError)
          return fail(
            error.code === "budget_exceeded"
              ? 429
              : error.code === "media_accounting_unavailable"
                ? 503
                : 422,
            error.code,
          );
        return fail(503, "media_accounting_unavailable");
      }
    }
  }
  let settled = false;
  const settle = async (
    status: "ok" | "error",
    result?: Pick<AudioTranscriptionResult, "usage">,
    notSent = false,
  ) => {
    if (settled) return;
    settled = true;
    if (spend && deps.accounting) {
      try {
        spend = (await deps.accounting.settle(spend, target.pricing, result, notSent)) ?? spend;
      } catch {
        c.get("logger")?.log("error", "media.asr_accounting_failed", {
          trace_id: c.get("trace_id"),
        });
      }
    }
    try {
      if (budget && deps.settleBudget)
        await deps.settleBudget(
          identity.keyId,
          spend ? { ...budget, spendUsd: null } : budget,
          { requests: 1, tokens: 0, costUsd: null },
          Date.now(),
        );
      await deps.record?.(target, identity.keyId, c.get("trace_id"), status, spend);
    } catch {
      c.get("logger")?.log("error", "media.asr_accounting_failed", { trace_id: c.get("trace_id") });
    }
  };
  if (body.stream) {
    const releaseConcurrency = c.get("concurrencyClaim")?.();
    const releaseMemory = c.get("requestMemoryRelease");
    c.set("requestMemoryRelease", undefined);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await releaseConcurrency?.();
      } finally {
        releaseMemory?.();
      }
    };
    c.header("content-type", "text/event-stream");
    return stream(c, async (out) => {
      const abort = new AbortController();
      const onAbort = () => {
        abort.abort();
        void release().catch(() => {});
      };
      out.onAbort(onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        for await (const chunk of client.chatCompletionStream(body, {
          signal: AbortSignal.any([signal, abort.signal]),
        }))
          await out.write(chunk);
        await settle("ok");
      } catch {
        await settle("error");
        if (!abort.signal.aborted)
          await out.write('data: {"error":{"code":"asr_stream_failed"}}\n\n');
      } finally {
        abort.abort();
        signal.removeEventListener("abort", onAbort);
        await release();
      }
    });
  }
  try {
    const result = await client.chatCompletion(body, { signal });
    const duration = NativeDuration.safeParse(result);
    await settle(
      "ok",
      duration.success
        ? { usage: { type: "duration", seconds: duration.data.usage.seconds } }
        : undefined,
    );
    return c.json({
      ...result,
      ...(spend
        ? {
            accounting: {
              operationId: spend.id,
              state: spend.state,
              reservedUsd: spend.reservedUsd,
              costUsd: spend.costUsd,
              costBasis: "list_price",
            },
          }
        : {}),
    });
  } catch (error) {
    const notSent = error instanceof MediaHttpError && error.outcome !== "unknown";
    await settle("error", undefined, notSent);
    return fail(502, spend && !notSent ? "outcome_unknown" : "asr_upstream_failed");
  }
}
