import { createBlockedModelMatcher, type ProviderClient, UpstreamError } from "@helm/core";
import { RealtimeSessionSchema } from "@helm/shared";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { requestSignal } from "../middleware/limits.js";
import type { RealtimeCallRegistry } from "../realtime-call-registry.js";
import {
  type BodyMemoryAdmission,
  memoryAdmissionReleaseGuard,
  RequestAdmissionError,
  readAdmittedRequestBody,
} from "../runtime/memory-admission.js";
import type { GeminiRateLimiterPort } from "./gemini.js";

const FORWARDED_HEADERS = [
  "openai-alpha",
  "originator",
  "session-id",
  "x-session-id",
  "thread-id",
  "version",
  "x-client-request-id",
  "x-codex-client-version",
  "x-oai-attestation",
] as const;

export interface RealtimeRouteDeps {
  auth: {
    resolve(credential: string | null): Promise<{
      keyId: string;
      blockedModels?: string[] | null;
      concurrencyLimit?: number | null;
      rateLimit?: { rpm: number | null; tpm: number | null };
    } | null>;
  };
  resolve(model: string): { client: ProviderClient; providerModel: string; alias: string } | null;
  registry: RealtimeCallRegistry;
  rateLimiter?: GeminiRateLimiterPort;
  concurrencyGate?: ConcurrencyGatePort;
  memoryAdmission?: BodyMemoryAdmission;
}

function bearer(value: string | undefined): string | null {
  const match = value ? /^Bearer\s+(.+)$/.exec(value) : null;
  return match?.[1] ?? null;
}

function error(
  c: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 413 | 429 | 502 | 503,
  message: string,
  code: string,
) {
  return c.json({ error: { type: "invalid_request_error", message, code, param: null } }, status);
}

async function partText(value: string | File | null): Promise<string> {
  if (typeof value === "string") return value;
  return value ? await value.text() : "";
}

export function registerRealtimeRoutes(app: Hono<AppEnv>, deps: RealtimeRouteDeps): void {
  for (const path of ["/v1/realtime/calls", "/v1/live"]) {
    app.use(path, concurrencyReleaseGuard());
    app.use(path, memoryAdmissionReleaseGuard());
  }

  const handle = async (c: Context<AppEnv>): Promise<Response> => {
    const identity = await deps.auth.resolve(bearer(c.req.header("Authorization")));
    if (!identity) return error(c, 401, "missing or invalid API key", "invalid_api_key");

    if (deps.rateLimiter) {
      const result = await deps.rateLimiter.check({
        keyId: identity.keyId,
        estimatedTokens: estimateRequestTokens(c),
        now: Date.now(),
        override: identity.rateLimit,
      });
      if (!result.allowed) {
        c.header("retry-after", String(result.retryAfterSeconds));
        return error(c, 429, `rate limit exceeded (${result.limitedBy})`, "rate_limit_exceeded");
      }
    }

    if (deps.concurrencyGate) {
      const acquired = await deps.concurrencyGate.acquire({
        keyId: identity.keyId,
        limit: identity.concurrencyLimit ?? null,
        signal: requestSignal(c),
      });
      if (!acquired.ok) {
        if (acquired.reason === "unavailable") {
          return error(c, 503, "concurrency lease unavailable", "server_overloaded");
        }
        c.header("retry-after", String(acquired.retryAfterSeconds));
        return error(
          c,
          429,
          "realtime call concurrency queue is unavailable",
          "rate_limit_exceeded",
        );
      }
      c.set(
        "concurrency_signal",
        AbortSignal.any([requestSignal(c), acquired.signal ?? requestSignal(c)]),
      );
      c.set("concurrencyRelease", acquired.release);
    }

    let bytes: Uint8Array;
    try {
      const admitted = deps.memoryAdmission
        ? await readAdmittedRequestBody(c.req.raw, deps.memoryAdmission)
        : null;
      bytes = admitted?.bytes ?? new Uint8Array(await c.req.arrayBuffer());
      if (admitted) c.set("requestMemoryRelease", admitted.release);
    } catch (cause) {
      if (cause instanceof RequestAdmissionError) {
        if (cause.status === 503) c.header("retry-after", "1");
        return error(c, cause.status, cause.message, cause.code);
      }
      return error(c, 400, "invalid realtime call body", "invalid_request");
    }

    const contentType = c.req.header("Content-Type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return error(c, 400, "realtime call requires multipart/form-data", "invalid_request");
    }

    let sdp = "";
    let model = "";
    let session: Record<string, unknown>;
    try {
      const form = await new Request("http://helm.internal/v1/realtime/calls", {
        method: "POST",
        headers: { "content-type": contentType },
        body: Buffer.from(bytes),
      }).formData();
      sdp = await partText(form.get("sdp"));
      const parsed = RealtimeSessionSchema.safeParse(
        JSON.parse(await partText(form.get("session"))),
      );
      if (!parsed.success || sdp.trim().length === 0) {
        return error(
          c,
          400,
          "realtime call requires valid sdp and session fields",
          "invalid_request",
        );
      }
      session = parsed.data;
      model = parsed.data.model;
    } catch {
      return error(c, 400, "realtime call contains malformed multipart fields", "invalid_request");
    }

    const target = deps.resolve(model);
    if (!target?.client.realtimeCall) {
      return error(
        c,
        404,
        `model '${model}' is not a configured realtime model`,
        "model_not_found",
      );
    }
    const blocked = createBlockedModelMatcher(identity.blockedModels);
    if (blocked?.matches(model) || blocked?.matches(target.alias)) {
      return error(c, 400, `model '${model}' is blocked for this key`, "model_blocked");
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = c.req.header(name);
      if (value) headers[name] = value;
    }

    try {
      const result = await target.client.realtimeCall(
        {
          endpoint: c.req.path === "/v1/live" ? "live" : "realtime",
          query: new URL(c.req.url).searchParams.toString(),
          sdp,
          session: { ...session, model: target.providerModel },
          headers,
        },
        { signal: requestSignal(c) },
      );
      deps.registry.put(result.callId, identity.keyId, result.sideband);
      return new Response(result.sdp, {
        status: result.status,
        headers: {
          "content-type": result.contentType ?? "application/sdp",
          location: result.location,
        },
      });
    } catch (cause) {
      const status =
        cause instanceof UpstreamError &&
        cause.upstreamStatus !== null &&
        cause.upstreamStatus >= 400 &&
        cause.upstreamStatus < 600
          ? cause.upstreamStatus
          : 502;
      return error(
        c,
        status === 400 ||
          status === 401 ||
          status === 403 ||
          status === 404 ||
          status === 413 ||
          status === 429 ||
          status === 503
          ? status
          : 502,
        cause instanceof Error ? cause.message : "realtime upstream failed",
        "upstream_error",
      );
    }
  };

  app.post("/v1/realtime/calls", handle);
  app.post("/v1/live", handle);
}
