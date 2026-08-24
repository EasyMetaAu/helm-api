import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  type ProviderClient,
  UpstreamError,
} from "@helm/core";
import { type ProviderAttempt, TtsSpeechRequestSchema } from "@helm/shared";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { requestSignal, requestTimedOut } from "../middleware/limits.js";
import {
  type BodyMemoryAdmission,
  memoryAdmissionReleaseGuard,
  RequestAdmissionError,
  readAdmittedRequestBody,
} from "../runtime/memory-admission.js";
import type { GeminiRateLimiterPort } from "./gemini.js";
import { buildImageDecision } from "./image-telemetry.js";
import type { MessagesIdentity } from "./messages.js";
import {
  captureEnabled,
  type RecordServedDeps,
  recordServed,
  withRequestContentMode,
} from "./payload-capture.js";

export interface TtsRouteDeps {
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  resolve: () => Pick<ProviderClient, "ttsSpeech" | "ttsVoices"> | null;
  memoryAdmission?: BodyMemoryAdmission;
  rateLimiter?: GeminiRateLimiterPort;
  concurrencyGate?: ConcurrencyGatePort;
  budgetGate?: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  settleBudget?: (
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: number | null },
    nowMs: number,
  ) => Promise<void>;
  captureServingAccount?<T>(call: () => Promise<T>): Promise<{
    result: T;
    servingAccount: { providerId: string; account: string } | null;
  }>;
  recordOAuthUsage?(
    servingAccount: { providerId: string; account: string } | null,
    servedAlias: string | null,
    usage: { tokens: number; costUsd: number | null },
  ): void;
  record?: RecordServedDeps;
}

function bearer(value: string | undefined): string | null {
  return /^Bearer\s+(.+)$/.exec(value ?? "")?.[1] ?? null;
}

function errorJson(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  message: string,
  code: string,
  type = "invalid_request_error",
) {
  return c.json({ error: { message, type, code, param: null } }, status);
}

function upstreamError(c: Context<AppEnv>, error: UpstreamError) {
  const status =
    error.errorClass === "timeout"
      ? 504
      : error.upstreamStatus !== null && error.upstreamStatus >= 400 && error.upstreamStatus < 600
        ? (error.upstreamStatus as ContentfulStatusCode)
        : 502;
  return errorJson(c, status, error.message, "upstream_error", "upstream_error");
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))
  );
}

function ttsDecision(input: {
  requestId: string;
  traceId: string;
  keyPrefix: string | null;
  status: "ok" | "error";
  errorClass: string | null;
  latencyMs: number;
  servingAccount: { providerId: string; account: string } | null;
}) {
  const attempt: ProviderAttempt = {
    alias: "xai/tts",
    skipped: false,
    skip_reason: null,
    status: input.status,
    error_class: input.errorClass,
    latency_ms: input.latencyMs,
    cost_usd: null,
    error_detail: null,
    provider_name: "xai",
    provider_model: "tts",
  };
  const decision = buildImageDecision({
    requestId: input.requestId,
    traceId: input.traceId,
    keyPrefix: input.keyPrefix,
    requested: "tts",
    selectedLane: "tts",
    candidateChain: ["xai/tts"],
    attempts: [attempt],
    served: input.status === "ok" ? { alias: "xai/tts", providerModel: "tts" } : null,
    finalErrorClass: input.errorClass,
    usage: null,
    policyReason: "tts_generation",
  });
  decision.serving_account = input.servingAccount
    ? {
        provider_id: input.servingAccount.providerId,
        account: input.servingAccount.account,
      }
    : null;
  return decision;
}

export function registerTtsRoute(app: Hono<AppEnv>, deps: TtsRouteDeps): void {
  app.use("/v1/tts", memoryAdmissionReleaseGuard());
  app.use("/v1/tts/*", memoryAdmissionReleaseGuard());
  app.use("/v1/tts", concurrencyReleaseGuard());
  app.use("/v1/tts/*", concurrencyReleaseGuard());

  async function admit(c: Context<AppEnv>): Promise<MessagesIdentity | Response> {
    const identity = await deps.auth.resolve(bearer(c.req.header("Authorization")));
    if (identity === null)
      return errorJson(c, 401, "missing or invalid API key", "invalid_api_key");
    if (deps.rateLimiter) {
      const rl = await deps.rateLimiter.check({
        keyId: identity.keyId,
        estimatedTokens: estimateRequestTokens(c),
        now: Date.now(),
        override: identity.caps?.rateLimit
          ? { rpm: identity.caps.rateLimit.rpm, tpm: identity.caps.rateLimit.tpm }
          : undefined,
      });
      if (!(rl.allowed && rl.limit === 0)) {
        c.header("x-ratelimit-limit", String(rl.limit));
        c.header("x-ratelimit-remaining", String(rl.remaining));
        c.header("x-ratelimit-reset", String(rl.resetSeconds));
        if (!rl.allowed) {
          c.header("retry-after", String(rl.retryAfterSeconds));
          return errorJson(
            c,
            429,
            "rate limit exceeded",
            "rate_limit_exceeded",
            "rate_limit_exceeded",
          );
        }
      }
    }
    if (deps.concurrencyGate) {
      const acquired = await deps.concurrencyGate.acquire({
        keyId: identity.keyId,
        limit: identity.caps?.concurrencyLimit ?? null,
        signal: requestSignal(c),
      });
      if (!acquired.ok) {
        if (acquired.reason === "unavailable")
          return errorJson(c, 503, "concurrency lease unavailable", "provider_unavailable");
        c.header("retry-after", String(acquired.retryAfterSeconds));
        return errorJson(c, 429, "concurrency limit exceeded", "rate_limit_exceeded");
      }
      c.set(
        "concurrency_signal",
        AbortSignal.any([requestSignal(c), acquired.signal ?? requestSignal(c)]),
      );
      c.set("concurrencyRelease", acquired.release);
    }
    return identity;
  }

  app.get("/v1/tts/voices", async (c) => {
    const admission = await admit(c);
    if (admission instanceof Response) return admission;
    const client = deps.resolve();
    if (!client?.ttsVoices)
      return errorJson(c, 503, "xAI TTS is unavailable", "provider_unavailable", "server_error");
    try {
      return c.json(await client.ttsVoices({ signal: requestSignal(c) }));
    } catch (error) {
      if (isAbortError(error)) return c.body(null, 499 as ContentfulStatusCode);
      return error instanceof UpstreamError
        ? upstreamError(c, error)
        : errorJson(c, 503, "xAI TTS is unavailable", "provider_unavailable", "server_error");
    }
  });

  app.post("/v1/tts", async (c) => {
    const admission = await admit(c);
    if (admission instanceof Response) return admission;
    const identity = admission;
    const client = deps.resolve();
    if (!client?.ttsSpeech)
      return errorJson(c, 503, "xAI TTS is unavailable", "provider_unavailable", "server_error");
    const requestId = c.get("request_id") ?? crypto.randomUUID();
    const traceId = c.get("trace_id") ?? requestId;
    const captureRecord = deps.record
      ? withRequestContentMode(deps.record, identity.caps?.requestContentMode)
      : undefined;
    const keyPrefix = typeof identity.keyPrefix === "string" ? identity.keyPrefix : null;
    const log = (event: string) =>
      console.warn(JSON.stringify({ level: "warn", event, trace_id: traceId }));
    let release: (() => void) | undefined;
    let requestJson = "";
    let upstreamRequestJson: string | null = null;
    let servingAccount: { providerId: string; account: string } | null = null;
    let providerStartedAt: number | null = null;
    try {
      const admitted = deps.memoryAdmission
        ? await readAdmittedRequestBody(c.req.raw, deps.memoryAdmission)
        : null;
      release = admitted?.release;
      requestJson = admitted?.text ?? (await c.req.text());
      const raw = JSON.parse(requestJson) as unknown;
      const parsed = TtsSpeechRequestSchema.safeParse(raw);
      if (!parsed.success)
        return errorJson(
          c,
          400,
          parsed.error.issues[0]?.message ?? "invalid TTS request",
          "invalid_request",
        );
      if (admitted) {
        c.set("requestMemoryRelease", admitted.release);
        admitted.materialized();
      }
      const budget = identity.caps?.budget;
      if (budget?.spendUsd !== null && budget?.spendUsd !== undefined) {
        return errorJson(
          c,
          422,
          "TTS pricing is unavailable for this spend-capped key",
          "media_pricing_unavailable",
        );
      }
      if (deps.budgetGate && budget) {
        const check = await deps.budgetGate.check({
          keyId: identity.keyId,
          caps: budget,
          nowMs: Date.now(),
        });
        if (check.overBudget) {
          return errorJson(
            c,
            429,
            "usage budget exceeded",
            "budget_exceeded",
            "rate_limit_exceeded",
          );
        }
      }

      providerStartedAt = Date.now();
      const invoke = () =>
        client.ttsSpeech?.(parsed.data, {
          signal: requestSignal(c),
          captureUpstream: (body) => {
            upstreamRequestJson = body;
          },
          onAccountSelected: (account) => {
            servingAccount = { providerId: "xai", account };
          },
        }) ?? Promise.reject(new Error("xAI TTS is unavailable"));
      const captured = deps.captureServingAccount
        ? await deps.captureServingAccount(invoke)
        : { result: await invoke(), servingAccount: null };
      const result = captured.result;
      servingAccount = captured.servingAccount ?? servingAccount;

      if (captureRecord) {
        await recordServed(
          captureRecord,
          {
            requestId,
            apiKeyId: identity.keyId,
            decision: ttsDecision({
              requestId,
              traceId,
              keyPrefix,
              status: "ok",
              errorClass: null,
              latencyMs: Date.now() - providerStartedAt,
              servingAccount,
            }),
            requestJson,
            responseJson: captureEnabled(captureRecord)
              ? JSON.stringify({ content_type: result.contentType, bytes: result.audio.byteLength })
              : null,
            timedOut: requestTimedOut(c),
            upstreamRequestJson,
          },
          log,
        );
      }
      deps.recordOAuthUsage?.(servingAccount, "xai/tts", { tokens: 0, costUsd: null });
      if (deps.settleBudget && budget) {
        try {
          await deps.settleBudget(
            identity.keyId,
            budget,
            { requests: 1, tokens: 0, costUsd: null },
            Date.now(),
          );
        } catch {
          log("budget.settle_failed");
        }
      }
      return new Response(result.audio, { headers: { "Content-Type": result.contentType } });
    } catch (error) {
      if (error instanceof RequestAdmissionError) {
        c.header("retry-after", "1");
        return errorJson(c, error.status, error.message, error.code, "server_error");
      }
      if (error instanceof SyntaxError)
        return errorJson(c, 400, "malformed TTS request body", "invalid_request");
      if (isAbortError(error)) return c.body(null, 499 as ContentfulStatusCode);
      if (captureRecord && providerStartedAt !== null) {
        const errorClass = error instanceof UpstreamError ? error.errorClass : "upstream_error";
        await recordServed(
          captureRecord,
          {
            requestId,
            apiKeyId: identity.keyId,
            decision: ttsDecision({
              requestId,
              traceId,
              keyPrefix,
              status: "error",
              errorClass,
              latencyMs: Date.now() - providerStartedAt,
              servingAccount,
            }),
            requestJson,
            responseJson: null,
            timedOut: requestTimedOut(c),
            upstreamRequestJson,
          },
          log,
        );
      }
      return error instanceof UpstreamError
        ? upstreamError(c, error)
        : errorJson(c, 503, "xAI TTS is unavailable", "provider_unavailable", "server_error");
    } finally {
      if (release && !c.get("requestMemoryRelease")) release();
    }
  });
}
