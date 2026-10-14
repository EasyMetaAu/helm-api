import { createHash, randomUUID } from "node:crypto";
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
  VideoExtensionRequestSchema,
  VideoGenerationRequestSchema,
  VideoRetrieveResponseSchema,
} from "@helm/shared";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { clientPolicyRejection } from "../middleware/client-policy.js";
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
import {
  ARK_TASK_TTL_MS,
  ARK_THREE_D_MODELS,
  ARK_VIDEO_MODELS,
  type ArkTaskKind,
  decodeArkTaskBinding,
  encodeArkTaskBinding,
  isArkTaskRecord,
  normalizeArkTaskResult,
  parseArkTaskCreate,
  parseArkTaskRequest,
  updateArkTaskState,
} from "./ark-media-task.js";
import type { GeminiRateLimiterPort } from "./gemini.js";
import { PASSTHROUGH_CLASSIFIER } from "./image-telemetry.js";
import { isNativeMediaTaskRecord } from "./media-task-binding.js";
import type { MessagesIdentity } from "./messages.js";
import {
  createNativeMediaTask,
  type NativeMediaTaskProfile,
  pollNativeMediaTask,
  readNativeMediaOperation,
} from "./native-media-tasks.js";
import {
  captureEnabled,
  type RecordServedDeps,
  recordServed,
  withRequestContentMode,
} from "./payload-capture.js";

type MediaTaskKind = ArkTaskKind | "transcription";
const VIDEO_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

export interface VideoCreateTarget {
  nativeTask?: NativeMediaTaskProfile;
  providerType?: "ark";
  laneName?: string;
  /** Ark tasks default to seven days; shorter TTLs are rejected before create. */
  registryTtlMs?: number;
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

export type VideoCreateOperation = "generation" | "extension";

export interface VideosRouteDeps {
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  registry: AtomicResponsesRegistryPort;
  resolver: {
    create(
      body: Record<string, unknown>,
      identity: MessagesIdentity,
      operation: VideoCreateOperation,
    ): Promise<VideoCreateTarget | null>;
    poll(record: ResponsesRegistryRecord): Promise<{
      nativeTask?: NativeMediaTaskProfile;
      providerType?: "ark";
      providerModel?: string;
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
  return status === "done" || status === "failed" || status === "expired" || status === "cancelled";
}

function normalizeVideoCreateBody(
  body: Record<string, unknown>,
  operation: VideoCreateOperation,
): Record<string, unknown> {
  if (operation !== "generation" || !Object.hasOwn(body, "images")) return body;
  const { images, ...rest } = body;
  return { ...rest, reference_images: images };
}

function registryRecord(
  responseId: string,
  identity: MessagesIdentity,
  target: VideoCreateTarget,
  nowMs: number,
  status = "in_progress",
  kind: MediaTaskKind = "video",
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
    selectedLane: kind,
    createdAt: nowMs,
    expiresAt:
      nowMs +
      (target.providerType === "ark"
        ? (target.registryTtlMs ?? ARK_TASK_TTL_MS)
        : VIDEO_REGISTRY_TTL_MS),
    status,
  };
}

function buildVideoDecision(input: {
  kind: MediaTaskKind;
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
    policy: {
      matched_policy_id: null,
      reason: input.kind === "video" ? "video_generation" : "three_d_generation",
    },
    lane: { selected_lane: input.kind, candidate_chain: [input.target.providerAlias] },
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
  registerMediaTaskRoutes(app, deps, "video");
}

/** Shared admission/reservation pipeline for the two existing asynchronous media shapes. */
export function registerMediaTaskRoutes(
  app: Hono<AppEnv>,
  deps: VideosRouteDeps,
  kind: MediaTaskKind,
): void {
  const root =
    kind === "video"
      ? "/v1/videos"
      : kind === "three-d"
        ? "/v1/3d"
        : "/v1/audio/transcription-jobs";
  const createPath = kind === "transcription" ? root : `${root}/generations`;
  const knownArkModels =
    kind === "video"
      ? ARK_VIDEO_MODELS
      : kind === "three-d"
        ? ARK_THREE_D_MODELS
        : new Set<string>();
  app.use(createPath, concurrencyReleaseGuard());
  app.use(createPath, memoryAdmissionReleaseGuard());
  app.use(`${root}/extensions`, concurrencyReleaseGuard());
  app.use(`${root}/extensions`, memoryAdmissionReleaseGuard());
  app.use(`${root}/:requestId`, concurrencyReleaseGuard());

  const createVideo = async (
    c: Context<AppEnv>,
    operation: VideoCreateOperation,
  ): Promise<Response> => {
    const identity = await deps.auth.resolve(extractBearer(c.req.header("Authorization")));
    if (identity === null)
      return errorJson(c, 401, "missing or invalid API key", "invalid_api_key");
    const denied = clientPolicyRejection(c, identity);
    if (denied) return denied;
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
      const rawBody: unknown = JSON.parse(raw);
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody))
        return errorJson(c, 400, "invalid media request object", "invalid_request");
      const rawRecord = rawBody as Record<string, unknown>;
      if (typeof rawRecord.model !== "string" || rawRecord.model.trim().length === 0)
        return errorJson(c, 400, "media model is required", "invalid_request");
      body = rawRecord;
      admitted?.materialized();
    } catch (error) {
      if (error instanceof RequestAdmissionError) {
        c.header("retry-after", "1");
        return errorJson(c, error.status, error.message, error.code);
      }
      return errorJson(c, 400, "malformed video generation request", "invalid_request");
    }

    const requestedModel = typeof body.model === "string" ? body.model : "";
    if (
      requestedModel.includes("/") &&
      !knownArkModels.has(requestedModel) &&
      identity.caps?.allowCustomModel !== true
    ) {
      return errorJson(c, 400, "video model is not available to this key", "model_not_found");
    }
    const target = await deps.resolver.create(body, identity, operation);
    if (target === null)
      return errorJson(c, 503, "video provider is unavailable", "provider_unavailable");
    const isArk = target.providerType === "ark";
    const isNative = target.nativeTask !== undefined;
    if (kind === "transcription" && !isNative)
      return errorJson(c, 503, "ASR provider unavailable", "provider_unavailable");
    const allowed = identity.caps?.allowedLanes;
    if (target.laneName !== undefined && allowed != null && !allowed.includes(target.laneName))
      return errorJson(c, 403, "media lane is not allowed for this key", "lane_not_allowed");

    if ((knownArkModels.has(requestedModel) || kind === "three-d") && !isArk)
      return errorJson(c, 503, "Ark media provider is unavailable", "provider_unavailable");
    if (target.nativeTask) {
      if (target.laneName === undefined && identity.caps?.allowCustomModel !== true)
        return errorJson(c, 403, "direct media model is unavailable", "model_not_found");
      if (operation !== "generation")
        return errorJson(c, 400, "media extension unsupported", "invalid_request");
      try {
        body = {
          ...target.nativeTask.validate(body, target.providerModel),
          model: requestedModel,
        };
      } catch {
        return errorJson(c, 400, "invalid media request", "invalid_request");
      }
    }
    if (isArk && kind !== "transcription") {
      if (target.laneName === undefined && identity.caps?.allowCustomModel !== true)
        return errorJson(
          c,
          400,
          "direct media model is not available to this key",
          "model_not_found",
        );
      if (operation === "extension")
        return errorJson(c, 400, "Ark media extension is unsupported", "invalid_request");
      const parsed = parseArkTaskRequest(kind, body, target.providerModel);
      if (!parsed.success)
        return errorJson(
          c,
          400,
          parsed.error.issues[0]?.message ?? "invalid Ark media request",
          "invalid_request",
        );
      body = { ...parsed.data, model: requestedModel };
      if (
        target.registryTtlMs !== undefined &&
        (!Number.isSafeInteger(target.registryTtlMs) || target.registryTtlMs < ARK_TASK_TTL_MS)
      )
        return errorJson(c, 503, "Ark media task retention is unavailable", "provider_unavailable");
    }
    if (!isArk && !isNative) {
      const parsed = (
        operation === "extension" ? VideoExtensionRequestSchema : VideoGenerationRequestSchema
      ).safeParse(body);
      if (!parsed.success)
        return errorJson(
          c,
          400,
          parsed.error.issues[0]?.message ?? "invalid video generation request",
          "invalid_request",
        );
      body = parsed.data;
    }
    const blocked = createBlockedModelMatcher(identity.caps?.blockedModels);
    if (
      blocked !== null &&
      (blocked.matches(requestedModel) ||
        blocked.matches(target.providerAlias) ||
        blocked.matches(target.providerModel))
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
    const upstreamBody = isArk || isNative ? body : normalizeVideoCreateBody(body, operation);
    const upstreamRequestJson = JSON.stringify({ ...upstreamBody, model: target.providerModel });
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
              kind,
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
                typeof (response as Record<string, unknown>)[isArk ? "id" : "request_id"] ===
                  "string"
                  ? ((response as Record<string, unknown>)[isArk ? "id" : "request_id"] as string)
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
        deps.log?.(`${kind}.telemetry.record_failed`, { request_id: helmRequestId });
      }
    };
    if (isNative && kind !== "three-d") {
      return createNativeMediaTask(c, deps, target, body, identity, kind, recordStart);
    }
    const reservation = registryRecord(
      `${kind}-create:${helmRequestId}`,
      identity,
      target,
      startedAt,
      "in_progress",
      kind,
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
        { ...upstreamBody, model: target.providerModel },
        requestSignal(c),
        async (account) => {
          target.providerAccount = account;
          await deps.registry.put({ ...reservation, providerAccount: account });
        },
      );
    } catch (failure) {
      if (isArk && failure !== null && typeof failure === "object") {
        const rejected = failure as { outcome?: unknown; upstreamStatus?: unknown };
        if (
          rejected.outcome === "rejected" &&
          typeof rejected.upstreamStatus === "number" &&
          rejected.upstreamStatus >= 400 &&
          rejected.upstreamStatus < 500 &&
          rejected.upstreamStatus !== 408
        ) {
          await recordStart("error", "upstream_rejected", null);
          return errorJson(
            c,
            rejected.upstreamStatus as ContentfulStatusCode,
            "media create was rejected by the provider",
            "upstream_rejected",
          );
        }
      }
      await recordStart("error", "outcome_unknown", null);
      return errorJson(c, 503, "video create outcome is unknown", "outcome_unknown");
    }
    const upstreamRequestId = isArk ? parseArkTaskCreate(upstream) : upstream.request_id;
    if (typeof upstreamRequestId !== "string" || upstreamRequestId.length === 0) {
      await recordStart("error", "outcome_unknown", null);
      return errorJson(c, 503, "video create outcome is unknown", "outcome_unknown");
    }
    const publicId = isArk ? randomUUID() : upstreamRequestId;
    try {
      const mappedStatus = isArk
        ? encodeArkTaskBinding({
            kind: kind === "three-d" ? "three-d" : "video",
            publicId,
            providerAlias: target.providerAlias,
            providerAccount: target.providerAccount,
            laneName: target.laneName ?? null,
            upstreamId: upstreamRequestId,
            providerName: target.providerName,
            providerModel: target.providerModel,
            state: "queued",
          })
        : String(upstream.status ?? "in_progress");
      const mapped = await deps.registry.putIfAbsent(
        registryRecord(
          `${kind}:${publicId}`,
          identity,
          target,
          isArk ? startedAt : now(),
          mappedStatus,
          kind,
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
    return c.json(isArk ? { request_id: publicId, status: "queued" } : upstream);
  };

  app.post(createPath, (c) => createVideo(c, "generation"));
  if (kind === "video") app.post(`${root}/extensions`, (c) => createVideo(c, "extension"));

  app.use(`${root}/operations/:operationId`, concurrencyReleaseGuard());
  app.get(`${root}/operations/:operationId`, async (c): Promise<Response> => {
    const identity = await deps.auth.resolve(extractBearer(c.req.header("Authorization")));
    if (!identity) return errorJson(c, 401, "missing or invalid API key", "invalid_api_key");
    const denied = clientPolicyRejection(c, identity);
    if (denied) return denied;
    const admission = await admit(c, deps, identity);
    if (admission) return admission;
    const id = c.req.param("operationId");
    let record: ResponsesRegistryRecord | null;
    try {
      record = await deps.registry.get(`${kind}-create:${id}`, identity);
    } catch {
      return errorJson(c, 503, "operation registry unavailable", "registry_unavailable");
    }
    if (
      !record ||
      record.accountId !== identity.accountId ||
      record.keyId !== identity.keyId ||
      record.selectedLane !== kind ||
      record.expiresAt <= (deps.now ?? Date.now)()
    )
      return errorJson(c, 404, "operation not found", "request_not_found");
    const operation = readNativeMediaOperation(record);
    if (!operation) return errorJson(c, 404, "operation not found", "request_not_found");
    return c.json({ operation_id: id, ...operation });
  });

  app.get(`${root}/:requestId`, async (c): Promise<Response> => {
    const identity = await deps.auth.resolve(extractBearer(c.req.header("Authorization")));
    if (identity === null)
      return errorJson(c, 401, "missing or invalid API key", "invalid_api_key");
    const denied = clientPolicyRejection(c, identity);
    if (denied) return denied;
    const admission = await admit(c, deps, identity);
    if (admission !== null) return admission;

    const requestId = c.req.param("requestId");
    const pollRequestId = c.get("request_id") ?? crypto.randomUUID();
    let record: ResponsesRegistryRecord | null;
    try {
      record = await deps.registry.get(`${kind}:${requestId}`, identity);
    } catch {
      return errorJson(c, 503, "media task registry is unavailable", "registry_unavailable");
    }
    if (record === null)
      return errorJson(c, 404, "video request was not found", "request_not_found");
    if (
      ((isArkTaskRecord(record) || isNativeMediaTaskRecord(record)) &&
        record.expiresAt <= (deps.now ?? Date.now)()) ||
      (kind === "three-d" && record.selectedLane !== kind) ||
      record.accountId !== identity.accountId ||
      record.keyId !== identity.keyId
    )
      return errorJson(c, 404, "media request was not found", "request_not_found");
    if (isNativeMediaTaskRecord(record) && kind !== "three-d") {
      return pollNativeMediaTask(c, deps, record, identity, kind, requestId);
    }
    if (kind === "transcription")
      return errorJson(c, 502, "invalid transcription binding", "upstream_error");
    const arkBinding = decodeArkTaskBinding(record, kind);
    if (isArkTaskRecord(record) && arkBinding === null)
      return errorJson(c, 502, "media task binding is invalid", "upstream_error");
    if (arkBinding !== null) {
      const blocked = createBlockedModelMatcher(identity.caps?.blockedModels);
      if (
        blocked !== null &&
        [record.providerAlias, record.providerModel, arkBinding.laneName].some(
          (value) => value !== null && blocked.matches(value),
        )
      )
        return errorJson(c, 400, "media model is blocked for this key", "model_blocked");
      const allowed = identity.caps?.allowedLanes;
      if (arkBinding.laneName !== null && allowed != null && !allowed.includes(arkBinding.laneName))
        return errorJson(c, 403, "media lane is not allowed for this key", "lane_not_allowed");
      if (arkBinding.laneName === null && identity.caps?.allowCustomModel !== true)
        return errorJson(
          c,
          400,
          "direct media model is not available to this key",
          "model_not_found",
        );
    }
    const client = await deps.resolver.poll(record);
    if (client === null)
      return errorJson(c, 503, "video provider is unavailable", "provider_unavailable");
    if (
      arkBinding !== null &&
      (client.providerType !== "ark" || client.providerModel !== record.providerModel)
    )
      return errorJson(c, 502, "media task provider binding differs", "upstream_error");
    if (arkBinding === null && (client.providerType === "ark" || kind === "three-d"))
      return errorJson(c, 502, "media task binding is missing", "upstream_error");
    let upstream: Record<string, unknown>;
    try {
      upstream = await client.retrieve(arkBinding?.upstreamId ?? requestId, requestSignal(c));
    } catch {
      deps.log?.(`${kind}.poll.lifecycle`, {
        request_id: pollRequestId,
        video_request_id: requestId,
        provider_alias: record.providerAlias,
        provider_account: record.providerAccount,
        status: "upstream_error",
        terminal: false,
      });
      return errorJson(c, 502, "video poll failed", "upstream_error");
    }
    const normalized =
      arkBinding === null
        ? null
        : normalizeArkTaskResult(kind, upstream, record, requestId, (deps.now ?? Date.now)());
    const parsed =
      arkBinding === null
        ? VideoRetrieveResponseSchema.safeParse(upstream)
        : normalized === null
          ? { success: false as const }
          : { success: true as const, data: normalized };
    if (!parsed.success) {
      deps.log?.(`${kind}.poll.lifecycle`, {
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
    deps.log?.(`${kind}.poll.lifecycle`, {
      request_id: pollRequestId,
      video_request_id: requestId,
      provider_alias: record.providerAlias,
      provider_account: record.providerAccount,
      status,
      terminal: isTerminal(upstream.status),
    });
    if (isTerminal(upstream.status)) {
      try {
        await deps.registry.put(
          arkBinding === null
            ? { ...record, status: upstream.status }
            : updateArkTaskState(record, kind, upstream.status),
        );
      } catch {
        deps.log?.(`${kind}.poll.terminal_state_update_failed`, {
          request_id: pollRequestId,
          video_request_id: requestId,
          status,
        });
      }
    }
    return c.json(upstream);
  });
}
