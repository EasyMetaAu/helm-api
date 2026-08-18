import { createHash } from "node:crypto";
import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  createBlockedModelMatcher,
  type DecisionRecord,
  type ResponsesRegistryRecord,
} from "@helm/core";
import {
  type ProviderAttempt,
  VideoGenerationRequestSchema,
  VideoRetrieveResponseSchema,
} from "@helm/shared";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import { requestSignal, requestTimedOut } from "../middleware/limits.js";
import type { AtomicResponsesRegistryPort } from "../responses-registry.js";
import {
  type BodyMemoryAdmission,
  memoryAdmissionReleaseGuard,
  RequestAdmissionError,
  readAdmittedRequestBody,
} from "../runtime/memory-admission.js";
import type { GeminiRateLimiterPort } from "./gemini.js";
import { PASSTHROUGH_CLASSIFIER } from "./image-telemetry.js";
import type { MessagesIdentity } from "./messages.js";
import {
  captureEnabled,
  type RecordServedDeps,
  recordServed,
  withRequestContentMode,
} from "./payload-capture.js";

const VIDEO_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

export interface VideoCreateTarget {
  providerAlias: string;
  providerName: string;
  providerModel: string;
  providerAccount: string | null;
  client: {
    create(
      body: Record<string, unknown>,
      signal: AbortSignal,
      onAccountSelected?: (account: string) => void | Promise<void>,
    ): Promise<Record<string, unknown>>;
  };
}

export interface VideosRouteDeps {
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  registry: AtomicResponsesRegistryPort;
  resolver: {
    create(
      body: Record<string, unknown>,
      identity: MessagesIdentity,
    ): Promise<VideoCreateTarget | null>;
    poll(record: ResponsesRegistryRecord): Promise<{
      retrieve(requestId: string, signal: AbortSignal): Promise<Record<string, unknown>>;
    } | null>;
  };
  rateLimiter?: GeminiRateLimiterPort;
  concurrencyGate?: ConcurrencyGatePort;
  memoryAdmission?: BodyMemoryAdmission;
  budgetGate?: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  settleBudget?: (
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: number | null },
    nowMs: number,
  ) => Promise<void>;
  /** Existing telemetry/payload recorder; production wires the same instance as images. */
  record?: RecordServedDeps;
  /** Body-free lifecycle events for asynchronous video polling. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
}

function extractBearer(value: string | undefined): string | null {
  return /^Bearer\s+(.+)$/.exec(value ?? "")?.[1] ?? null;
}

function errorJson(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  message: string,
  code: string,
): Response {
  return c.json({ error: { message, type: "invalid_request_error", code, param: null } }, status);
}

function isTerminal(status: unknown): status is string {
  return status === "done" || status === "failed" || status === "expired";
}

function registryRecord(
  responseId: string,
  identity: MessagesIdentity,
  target: VideoCreateTarget,
  nowMs: number,
  status = "in_progress",
): ResponsesRegistryRecord {
  return {
    responseId,
    accountId: identity.accountId,
    keyId: identity.keyId,
    providerAlias: target.providerAlias,
    providerName: target.providerName,
    providerModel: target.providerModel,
    providerProtocol: null,
    providerAccount: target.providerAccount,
    selectedLane: "video",
    createdAt: nowMs,
    expiresAt: nowMs + VIDEO_REGISTRY_TTL_MS,
    status,
  };
}

function buildVideoDecision(input: {
  requestId: string;
  traceId: string;
  keyPrefix: string | null;
  requestedModel: string;
  target: VideoCreateTarget;
  status: "ok" | "error";
  errorClass: string | null;
  latencyMs: number;
  upstreamRequestId?: string;
}): DecisionRecord {
  const attempt: ProviderAttempt = {
    alias: input.target.providerAlias,
    skipped: false,
    skip_reason: null,
    status: input.status,
    error_class: input.errorClass,
    latency_ms: input.latencyMs,
    cost_usd: null,
    error_detail: null,
    provider_name: input.target.providerName,
    provider_model: input.target.providerModel,
    ...(input.upstreamRequestId
      ? {
          upstream_request_ref: `sha256:${createHash("sha256").update(input.upstreamRequestId).digest("hex")}`,
        }
      : {}),
  };
  return {
    request_id: input.requestId,
    trace_id: input.traceId,
    requested_model: input.requestedModel,
    protocol: null,
    key_prefix: input.keyPrefix,
    classifier: PASSTHROUGH_CLASSIFIER,
    policy: { matched_policy_id: null, reason: "video_generation" },
    lane: { selected_lane: "video", candidate_chain: [input.target.providerAlias] },
    provider_attempts: [attempt],
    final:
      input.status === "ok"
        ? {
            model_alias: input.target.providerAlias,
            provider_model: input.target.providerModel,
            status: "ok",
            error_reason: null,
          }
        : {
            model_alias: null,
            provider_model: null,
            status: "error",
            error_reason: input.errorClass,
          },
    latency_total_ms: input.latencyMs,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: null, total_usd: null },
    memory: null,
    usage: null,
    stream_outcome: null,
    generation_ms: null,
    serving_account:
      input.target.providerAccount !== null
        ? { provider_id: input.target.providerName, account: input.target.providerAccount }
        : null,
  };
}

async function admit(
  c: Context<AppEnv>,
  deps: VideosRouteDeps,
  identity: MessagesIdentity,
): Promise<Response | null> {
  if (deps.rateLimiter !== undefined) {
    const rate = await deps.rateLimiter.check({
      keyId: identity.keyId,
      estimatedTokens: estimateRequestTokens(c),
      now: Date.now(),
      override: identity.caps?.rateLimit,
    });
    if (!(rate.allowed && rate.limit === 0)) {
      c.header("x-ratelimit-limit", String(rate.limit));
      c.header("x-ratelimit-remaining", String(rate.remaining));
      c.header("x-ratelimit-reset", String(rate.resetSeconds));
      if (!rate.allowed) {
        c.header("retry-after", String(rate.retryAfterSeconds));
        return errorJson(c, 429, `rate limit exceeded (${rate.limitedBy})`, "rate_limit_exceeded");
      }
    }
  }
  if (deps.concurrencyGate === undefined) return null;
  const acquired = await deps.concurrencyGate.acquire({
    keyId: identity.keyId,
    limit: identity.caps?.concurrencyLimit ?? null,
    signal: requestSignal(c),
  });
  if (!acquired.ok) {
    if (acquired.reason === "unavailable") {
      return errorJson(c, 503, "concurrency lease unavailable", "concurrency_unavailable");
    }
    c.header("retry-after", String(acquired.retryAfterSeconds));
    return errorJson(c, 429, "concurrency limit exceeded", "rate_limit_exceeded");
  }
  c.set(
    "concurrency_signal",
    AbortSignal.any([requestSignal(c), acquired.signal ?? requestSignal(c)]),
  );
  c.set("concurrencyRelease", acquired.release);
  return null;
}

export function registerVideosRoute(app: Hono<AppEnv>, deps: VideosRouteDeps): void {
  app.use("/v1/videos/generations", concurrencyReleaseGuard());
  app.use("/v1/videos/generations", memoryAdmissionReleaseGuard());
  app.use("/v1/videos/:requestId", concurrencyReleaseGuard());

  app.post("/v1/videos/generations", async (c): Promise<Response> => {
    const identity = await deps.auth.resolve(extractBearer(c.req.header("Authorization")));
    if (identity === null)
      return errorJson(c, 401, "missing or invalid API key", "invalid_api_key");
    const captureRecord =
      deps.record === undefined
        ? undefined
        : withRequestContentMode(deps.record, identity.caps?.requestContentMode);
    const helmRequestId = c.get("request_id") ?? crypto.randomUUID();
    const traceId = c.get("trace_id") ?? helmRequestId;
    const keyPrefix = typeof identity.keyPrefix === "string" ? identity.keyPrefix : null;
    const admission = await admit(c, deps, identity);
    if (admission !== null) return admission;

    let body: Record<string, unknown>;
    let requestJson = "";
    try {
      const admitted =
        deps.memoryAdmission === undefined
          ? null
          : await readAdmittedRequestBody(c.req.raw, deps.memoryAdmission);
      const raw = admitted?.text ?? (await c.req.text());
      requestJson = raw;
      if (admitted !== null) c.set("requestMemoryRelease", admitted.release);
      const parsed = VideoGenerationRequestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return errorJson(
          c,
          400,
          parsed.error.issues[0]?.message ?? "invalid video generation request",
          "invalid_request",
        );
      }
      body = parsed.data;
      admitted?.materialized();
    } catch (error) {
      if (error instanceof RequestAdmissionError) {
        c.header("retry-after", "1");
        return errorJson(c, error.status, error.message, error.code);
      }
      return errorJson(c, 400, "malformed video generation request", "invalid_request");
    }

    const requestedModel = typeof body.model === "string" ? body.model : "";
    if (requestedModel.includes("/") && identity.caps?.allowCustomModel !== true) {
      return errorJson(c, 400, "video model is not available to this key", "model_not_found");
    }
    const target = await deps.resolver.create(body, identity);
    if (target === null)
      return errorJson(c, 503, "video provider is unavailable", "provider_unavailable");
    const blocked = createBlockedModelMatcher(identity.caps?.blockedModels);
    if (
      blocked !== null &&
      (blocked.matches(requestedModel) || blocked.matches(target.providerAlias))
    ) {
      return errorJson(c, 400, "video model is blocked for this key", "model_blocked");
    }
    if ((identity.caps?.budget?.spendUsd ?? 0) > 0) {
      return errorJson(
        c,
        422,
        "video pricing is unavailable for this spend-capped key",
        "media_pricing_unavailable",
      );
    }
    if (deps.budgetGate !== undefined && identity.caps?.budget !== undefined) {
      const budget = await deps.budgetGate.check({
        keyId: identity.keyId,
        caps: identity.caps.budget,
        nowMs: Date.now(),
      });
      if (budget.overBudget && budget.behavior === "reject") {
        return errorJson(c, 429, "usage budget exceeded", "rate_limit_exceeded");
      }
    }

    const now = deps.now ?? Date.now;
    const startedAt = now();
    const upstreamRequestJson = JSON.stringify({ ...body, model: target.providerModel });
    const recordStart = async (
      status: "ok" | "error",
      errorClass: string | null,
      response: unknown,
    ) => {
      if (captureRecord === undefined) return;
      try {
        await recordServed(
          captureRecord,
          {
            requestId: helmRequestId,
            accountId: identity.accountId,
            apiKeyId: identity.keyId,
            decision: buildVideoDecision({
              requestId: helmRequestId,
              traceId,
              keyPrefix,
              requestedModel,
              target,
              status,
              errorClass,
              latencyMs: Math.max(0, now() - startedAt),
              upstreamRequestId:
                response !== null &&
                typeof response === "object" &&
                typeof (response as Record<string, unknown>).request_id === "string"
                  ? ((response as Record<string, unknown>).request_id as string)
                  : undefined,
            }),
            requestJson,
            responseJson:
              status === "ok" && captureEnabled(captureRecord) ? JSON.stringify(response) : null,
            timedOut: requestTimedOut(c),
            upstreamRequestJson,
          },
          (event) => deps.log?.(event, { request_id: helmRequestId }),
        );
      } catch {
        // Observability is fail-open after a paid or ambiguous provider attempt.
        deps.log?.("video.telemetry.record_failed", { request_id: helmRequestId });
      }
    };
    const reservation = registryRecord(
      `video-create:${helmRequestId}`,
      identity,
      target,
      startedAt,
    );
    let reserved: boolean;
    try {
      reserved = await deps.registry.putIfAbsent(reservation);
    } catch {
      await recordStart("error", "outcome_unknown", null);
      return errorJson(c, 503, "video create outcome is unknown", "outcome_unknown");
    }
    if (!reserved) {
      await recordStart("error", "outcome_unknown", null);
      return errorJson(c, 503, "video create outcome is unknown", "outcome_unknown");
    }

    let upstream: Record<string, unknown>;
    try {
      upstream = await target.client.create(
        { ...body, model: target.providerModel },
        requestSignal(c),
        async (account) => {
          target.providerAccount = account;
          await deps.registry.put({ ...reservation, providerAccount: account });
        },
      );
    } catch {
      await recordStart("error", "outcome_unknown", null);
      return errorJson(c, 503, "video create outcome is unknown", "outcome_unknown");
    }
    const upstreamRequestId = upstream.request_id;
    if (typeof upstreamRequestId !== "string" || upstreamRequestId.length === 0) {
      await recordStart("error", "outcome_unknown", null);
      return errorJson(c, 503, "video create outcome is unknown", "outcome_unknown");
    }
    try {
      const mapped = await deps.registry.putIfAbsent(
        registryRecord(
          `video:${upstreamRequestId}`,
          identity,
          target,
          now(),
          String(upstream.status ?? "in_progress"),
        ),
      );
      if (!mapped) {
        await recordStart("error", "outcome_unknown", upstream);
        return errorJson(c, 503, "video create outcome is unknown", "outcome_unknown");
      }
    } catch {
      await recordStart("error", "outcome_unknown", upstream);
      return errorJson(c, 503, "video create outcome is unknown", "outcome_unknown");
    }
    await recordStart("ok", null, upstream);
    if (deps.settleBudget !== undefined && identity.caps?.budget !== undefined) {
      try {
        await deps.settleBudget(
          identity.keyId,
          identity.caps.budget,
          { requests: 1, tokens: 0, costUsd: null },
          Date.now(),
        );
      } catch {
        // Budget settlement is explicitly fail-open after a paid provider call.
      }
    }
    return c.json(upstream);
  });

  app.get("/v1/videos/:requestId", async (c): Promise<Response> => {
    const identity = await deps.auth.resolve(extractBearer(c.req.header("Authorization")));
    if (identity === null)
      return errorJson(c, 401, "missing or invalid API key", "invalid_api_key");
    const admission = await admit(c, deps, identity);
    if (admission !== null) return admission;

    const requestId = c.req.param("requestId");
    const pollRequestId = c.get("request_id") ?? crypto.randomUUID();
    const record = await deps.registry.get(`video:${requestId}`, identity);
    if (record === null)
      return errorJson(c, 404, "video request was not found", "request_not_found");
    const client = await deps.resolver.poll(record);
    if (client === null)
      return errorJson(c, 503, "video provider is unavailable", "provider_unavailable");
    let upstream: Record<string, unknown>;
    try {
      upstream = await client.retrieve(requestId, requestSignal(c));
    } catch {
      deps.log?.("video.poll.lifecycle", {
        request_id: pollRequestId,
        video_request_id: requestId,
        provider_alias: record.providerAlias,
        provider_account: record.providerAccount,
        status: "upstream_error",
        terminal: false,
      });
      return errorJson(c, 502, "video poll failed", "upstream_error");
    }
    const parsed = VideoRetrieveResponseSchema.safeParse(upstream);
    if (!parsed.success) {
      deps.log?.("video.poll.lifecycle", {
        request_id: pollRequestId,
        video_request_id: requestId,
        provider_alias: record.providerAlias,
        provider_account: record.providerAccount,
        status: "upstream_error",
        terminal: false,
      });
      return errorJson(c, 502, "video poll returned an invalid response", "upstream_error");
    }
    upstream = parsed.data;
    const status = upstream.status;
    deps.log?.("video.poll.lifecycle", {
      request_id: pollRequestId,
      video_request_id: requestId,
      provider_alias: record.providerAlias,
      provider_account: record.providerAccount,
      status,
      terminal: isTerminal(upstream.status),
    });
    if (isTerminal(upstream.status)) {
      try {
        await deps.registry.put({ ...record, status: upstream.status });
      } catch {
        deps.log?.("video.poll.terminal_state_update_failed", {
          request_id: pollRequestId,
          video_request_id: requestId,
          status,
        });
      }
    }
    return c.json(upstream);
  });
}
