import {
  createBlockedModelMatcher,
  type ProviderClient,
  parseBailianShortAsrRequest,
} from "@helm/core";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AppEnv } from "../app.js";
import { requestSignal } from "../middleware/limits.js";
import type { AudioSpeechRouteDeps } from "./audio-speech.js";
export interface ShortAsrTarget {
  client: Pick<ProviderClient, "chatCompletion" | "chatCompletionStream"> | null;
  alias: string;
  model: string;
  lane: string;
  customModel: boolean;
}
export interface ShortAsrDeps extends Pick<AudioSpeechRouteDeps, "budgetGate" | "settleBudget"> {
  resolve(model: string): ShortAsrTarget | null;
  record?(
    target: ShortAsrTarget,
    keyId: string,
    traceId: string,
    status: "ok" | "error",
  ): Promise<void>;
}
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
  const fail = (status: 400 | 403 | 422 | 429 | 502 | 503, code: string) =>
    c.json({ error: { type: "api_error", code, message: code.replaceAll("_", " ") } }, status);
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
  if (budget?.spendUsd != null) return fail(422, "media_pricing_unavailable");
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
  let settled = false;
  const settle = async (status: "ok" | "error") => {
    if (settled) return;
    settled = true;
    try {
      if (budget && deps.settleBudget)
        await deps.settleBudget(
          identity.keyId,
          budget,
          { requests: 1, tokens: 0, costUsd: null },
          Date.now(),
        );
      await deps.record?.(target, identity.keyId, c.get("trace_id"), status);
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
    await settle("ok");
    return c.json(result);
  } catch {
    await settle("error");
    return fail(502, "asr_upstream_failed");
  }
}
