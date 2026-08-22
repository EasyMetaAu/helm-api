import { type ProviderClient, UpstreamError } from "@helm/core";
import { TtsSpeechRequestSchema } from "@helm/shared";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { requestSignal } from "../middleware/limits.js";
import {
  type BodyMemoryAdmission,
  memoryAdmissionReleaseGuard,
  RequestAdmissionError,
  readAdmittedRequestBody,
} from "../runtime/memory-admission.js";
import type { GeminiRateLimiterPort } from "./gemini.js";
import type { MessagesIdentity } from "./messages.js";

export interface TtsRouteDeps {
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  resolve: () => Pick<ProviderClient, "ttsSpeech" | "ttsVoices"> | null;
  memoryAdmission?: BodyMemoryAdmission;
  rateLimiter?: GeminiRateLimiterPort;
  concurrencyGate?: ConcurrencyGatePort;
}

function bearer(value: string | undefined): string | null {
  return /^Bearer\s+(.+)$/.exec(value ?? "")?.[1] ?? null;
}

function errorJson(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  message: string,
  code: string,
) {
  return c.json({ error: { message, type: "invalid_request_error", code, param: null } }, status);
}

function upstreamError(c: Context<AppEnv>, error: UpstreamError) {
  const status =
    error.upstreamStatus !== null && error.upstreamStatus >= 400 && error.upstreamStatus < 600
      ? (error.upstreamStatus as ContentfulStatusCode)
      : 502;
  return errorJson(c, status, error.message, "upstream_error");
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
      if (!rl.allowed) {
        c.header("retry-after", String(rl.retryAfterSeconds));
        return errorJson(c, 429, "rate limit exceeded", "rate_limit_exceeded");
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
      return errorJson(c, 503, "xAI TTS is unavailable", "provider_unavailable");
    try {
      return c.json(await client.ttsVoices({ signal: requestSignal(c) }));
    } catch (error) {
      return error instanceof UpstreamError
        ? upstreamError(c, error)
        : errorJson(c, 503, "xAI TTS is unavailable", "provider_unavailable");
    }
  });

  app.post("/v1/tts", async (c) => {
    const admission = await admit(c);
    if (admission instanceof Response) return admission;
    const client = deps.resolve();
    if (!client?.ttsSpeech)
      return errorJson(c, 503, "xAI TTS is unavailable", "provider_unavailable");
    let release: (() => void) | undefined;
    try {
      const admitted = deps.memoryAdmission
        ? await readAdmittedRequestBody(c.req.raw, deps.memoryAdmission)
        : null;
      release = admitted?.release;
      const raw = JSON.parse(admitted?.text ?? (await c.req.text())) as unknown;
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
      const result = await client.ttsSpeech(parsed.data, { signal: requestSignal(c) });
      return new Response(result.audio, { headers: { "Content-Type": result.contentType } });
    } catch (error) {
      if (error instanceof RequestAdmissionError)
        return errorJson(c, error.status, error.message, error.code);
      if (error instanceof SyntaxError)
        return errorJson(c, 400, "malformed TTS request body", "invalid_request");
      return error instanceof UpstreamError
        ? upstreamError(c, error)
        : errorJson(c, 503, "xAI TTS is unavailable", "provider_unavailable");
    } finally {
      if (release && !c.get("requestMemoryRelease")) release();
    }
  });
}
