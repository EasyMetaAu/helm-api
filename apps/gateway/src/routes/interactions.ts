import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  type CircuitBreaker,
  createBlockedModelMatcher,
} from "@helm/core";
import { type InteractionInputBlock, InteractionsRequestSchema } from "@helm/shared";
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
import {
  type ImageAttempt,
  type ImageChainTarget,
  type ResolveImageChain,
  runImageChain,
} from "./image-chain.js";
import { buildImageDecision, numField } from "./image-telemetry.js";
import { geminiImageUsageBody } from "./image-usage.js";
import type { MessagesIdentity } from "./messages.js";
import { captureEnabled, type RecordServedDeps, recordServed } from "./payload-capture.js";

// POST /v1beta/interactions — Google Gemini Interactions API (the modern image-gen
// surface for the gemini-*-image "Nano Banana" models; the SDK's
// `client.interactions.create(...)`). A model-pinned endpoint that ALSO fails over
// across providers: the requested id may be a bare gemini image model (one-element
// chain) or an image LANE, and the route runs the resolved gemini-kind chain through
// runImageChain (same breaker + terminal/fallback rules as the chat executor).
//
// Helm's upstream (ZenMux Vertex) speaks `generateContent`, NOT `/v1beta/interactions`,
// so this route TRANSLATES: the interactions request → a generateContent call
// (responseModalities IMAGE) forwarded verbatim via nativePassthrough, then the
// generateContent `inlineData` response → the interactions `steps` shape. Only
// gemini-kind targets are served here; an openai-kind model (gpt-image-2) → 400.

export interface InteractionsRouteDeps {
  rateLimiter?: GeminiRateLimiterPort;
  concurrencyGate?: ConcurrencyGatePort;
  /** Machine-derived request-body budget shared by every AI ingress surface. */
  memoryAdmission?: BodyMemoryAdmission;
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  /** SAME resolver the /v1/images/generations route uses. Returns the ordered image
   *  chain (both kinds); this route filters to gemini-kind and 400s an openai-only id. */
  resolveImageChain: ResolveImageChain;
  /** Per-alias circuit breaker — the SAME instance the chat executor uses. */
  breaker: CircuitBreaker;
  /** Price the served body at the SERVED alias's catalog pricing (resolveCostUsd). */
  costOf(alias: string, body: unknown): number | null;
  /** Per-key usage-budget gate + settle (docs/06) — the SAME instances the chat face uses. */
  budgetGate?: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  settleBudget?: (
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: number | null },
    nowMs: number,
  ) => Promise<void>;
  record?: RecordServedDeps;
}

// Gemini error envelope (`{error:{code,message,status}}`) — what the Gemini SDK expects.
function errorJson(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  message: string,
  geminiStatus: string,
): Response {
  return c.json({ error: { code: status, message, status: geminiStatus } }, status);
}

// Map a terminal chain error class → the Gemini canonical status string.
function geminiStatusFor(errorClass: string): string {
  switch (errorClass) {
    case "invalid_request":
      return "INVALID_ARGUMENT";
    case "lane_unavailable":
      return "UNAVAILABLE";
    case "client_abort":
      return "CANCELLED";
    default:
      return "INTERNAL";
  }
}

// x-goog-api-key (Gemini SDK default) or Authorization: Bearer (own clients). Never
// trim/lowercase a key.
function extractCredential(googKey: string | undefined, auth: string | undefined): string | null {
  if (googKey) return googKey;
  if (auth) {
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (m?.[1]) return m[1];
  }
  return null;
}

// interactions `input` (string | typed blocks) → generateContent `contents`. A text
// block → {text}; an image block → {inlineData:{mimeType,data}} (Gemini's image-input
// shape, for image editing). Unknown block types are skipped (best-effort v1).
function inputToContents(input: unknown): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (typeof input === "string") {
    parts.push({ text: input });
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      const b = raw as InteractionInputBlock;
      if (b.type === "text" && typeof b.text === "string") parts.push({ text: b.text });
      else if (b.type === "image" && typeof b.data === "string") {
        parts.push({ inlineData: { mimeType: b.mime_type ?? "image/png", data: b.data } });
      }
    }
  }
  return [{ role: "user", parts }];
}

// interactions `response_format` + `generation_config` → generateContent
// `generationConfig`. The client's accepted `generation_config` is forwarded (helm
// never silently drops a field it accepted) — the one documented Interactions knob
// `thinking_level` is mapped to generateContent's `thinkingConfig.thinkingLevel`;
// other fields (temperature, seed, …) ride through. IMAGE output + imageConfig
// (aspect_ratio / image_size) are then FORCED on top, always winning over the client.
function buildGenerationConfig(
  responseFormat: unknown,
  generationConfig: unknown,
): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (generationConfig !== null && typeof generationConfig === "object") {
    const { thinking_level, ...rest } = generationConfig as Record<string, unknown>;
    Object.assign(cfg, rest);
    if (typeof thinking_level === "string") cfg.thinkingConfig = { thinkingLevel: thinking_level };
  }
  cfg.responseModalities = ["TEXT", "IMAGE"];
  if (responseFormat !== null && typeof responseFormat === "object") {
    const rf = responseFormat as Record<string, unknown>;
    const imageConfig: Record<string, unknown> = {};
    if (typeof rf.aspect_ratio === "string") imageConfig.aspectRatio = rf.aspect_ratio;
    if (typeof rf.image_size === "string") imageConfig.imageSize = rf.image_size;
    if (Object.keys(imageConfig).length > 0) cfg.imageConfig = imageConfig;
  }
  return cfg;
}

// generateContent native response → the interactions `steps` shape. The model_output
// step's content carries text + image blocks; the SDK's `interaction.output_image.data`
// reads the image block's `data`. usageMetadata is mapped separately (for cost).
function nativeToInteractions(
  native: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  const candidates = Array.isArray(native.candidates) ? native.candidates : [];
  for (const cand of candidates) {
    const parts = (cand as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const p = part as { text?: unknown; inlineData?: { data?: unknown; mimeType?: unknown } };
      if (typeof p.text === "string") content.push({ type: "text", text: p.text });
      else if (p.inlineData && typeof p.inlineData.data === "string") {
        content.push({
          type: "image",
          mime_type:
            typeof p.inlineData.mimeType === "string" ? p.inlineData.mimeType : "image/png",
          data: p.inlineData.data,
        });
      }
    }
  }
  return { id, steps: [{ type: "model_output", status: "done", content }] };
}

// generateContent usageMetadata → the OpenAI-ish usage body resolveCostUsd prices
// (output_tokens = the image's candidatesTokenCount). Same shape the images route uses.
function usageBodyFromNative(native: Record<string, unknown>): { usage: Record<string, unknown> } {
  return geminiImageUsageBody((native.usageMetadata ?? {}) as Record<string, unknown>);
}

export function registerInteractionsRoute(app: Hono<AppEnv>, deps: InteractionsRouteDeps): void {
  app.use("/v1beta/interactions", concurrencyReleaseGuard());
  app.use("/v1beta/interactions", memoryAdmissionReleaseGuard());

  app.post("/v1beta/interactions", async (c) => {
    // Production always receives both ids from createApp. The UUID fallback keeps
    // this route safely usable in isolated/headless Hono composition tests without
    // ever consulting a client header for the storage key.
    const requestId = c.get("request_id") ?? crypto.randomUUID();
    const traceId = c.get("trace_id") ?? requestId;
    const log = (msg: string) =>
      console.warn(JSON.stringify({ level: "warn", event: msg, trace_id: traceId }));

    // 1) Auth — x-goog-api-key (Gemini SDK) or Bearer fallback.
    const identity = await deps.auth.resolve(
      extractCredential(c.req.header("x-goog-api-key"), c.req.header("Authorization")),
    );
    if (identity === null) {
      return errorJson(c, 401, "missing or invalid API key", "UNAUTHENTICATED");
    }
    const keyPrefix = typeof identity.keyPrefix === "string" ? identity.keyPrefix : null;

    // 2) Rate limit AFTER auth.
    if (deps.rateLimiter !== undefined) {
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
          return errorJson(c, 429, `rate limit exceeded (${rl.limitedBy})`, "RESOURCE_EXHAUSTED");
        }
      }
    }

    // 3) Concurrency overflow queue AFTER rate-limit.
    if (deps.concurrencyGate !== undefined) {
      const acquired = await deps.concurrencyGate.acquire({
        keyId: identity.keyId,
        limit: identity.caps?.concurrencyLimit ?? null,
        signal: requestSignal(c),
      });
      if (!acquired.ok) {
        if (acquired.reason === "unavailable") {
          return errorJson(c, 503, "concurrency lease unavailable", "UNAVAILABLE");
        }
        c.header("retry-after", String(acquired.retryAfterSeconds));
        return errorJson(
          c,
          429,
          acquired.reason === "queue_full"
            ? "concurrency queue is full"
            : "timed out waiting for a concurrency slot",
          "RESOURCE_EXHAUSTED",
        );
      }
      c.set(
        "concurrency_signal",
        AbortSignal.any([requestSignal(c), acquired.signal ?? requestSignal(c)]),
      );
      c.set("concurrencyRelease", acquired.release);
    }

    // 4) Parse + validate.
    let requestJson = "";
    let raw: unknown;
    let requestBodyMaterialized: (() => void) | undefined;
    try {
      const admitted =
        deps.memoryAdmission === undefined
          ? null
          : await readAdmittedRequestBody(c.req.raw, deps.memoryAdmission);
      requestJson = admitted?.text ?? (await c.req.text());
      if (admitted !== null) {
        c.set("requestMemoryRelease", admitted.release);
        requestBodyMaterialized = admitted.materialized;
      }
      raw = JSON.parse(requestJson);
    } catch (error) {
      if (error instanceof RequestAdmissionError) {
        if (error.status === 503) c.header("retry-after", "1");
        return errorJson(
          c,
          error.status,
          error.message,
          error.status === 413 ? "INVALID_ARGUMENT" : "UNAVAILABLE",
        );
      }
      return errorJson(c, 400, "malformed JSON request body", "INVALID_ARGUMENT");
    }
    const parsed = InteractionsRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return errorJson(
        c,
        400,
        parsed.error.issues[0]?.message ?? "invalid interactions request",
        "INVALID_ARGUMENT",
      );
    }
    requestBodyMaterialized?.();

    // 5) Resolve the model/lane → the chain, then keep only gemini-kind targets (this
    //    endpoint translates to generateContent). An openai-only id → 400 (→ images).
    const chain = deps.resolveImageChain(parsed.data.model);
    if (!chain.ok) {
      return chain.status === 404
        ? errorJson(
            c,
            404,
            `model '${parsed.data.model}' is not a configured image model`,
            "NOT_FOUND",
          )
        : errorJson(
            c,
            503,
            `image provider for '${parsed.data.model}' is unavailable (missing credential)`,
            "UNAVAILABLE",
          );
    }
    const blockedModels = createBlockedModelMatcher(identity.caps?.blockedModels);
    const permittedTargets =
      blockedModels === null
        ? chain.targets
        : chain.targets.filter((target) => !blockedModels.matches(target.alias));
    const permittedCandidateChain =
      blockedModels === null
        ? chain.candidateChain
        : chain.candidateChain.filter((alias) => !blockedModels.matches(alias));
    if (permittedTargets.length === 0) {
      const directBlocked =
        chain.laneName !== parsed.data.model && blockedModels?.matches(parsed.data.model) === true;
      return errorJson(
        c,
        400,
        directBlocked
          ? `model '${parsed.data.model}' is blocked for this key`
          : `all image candidate models for '${parsed.data.model}' are blocked for this key`,
        "INVALID_ARGUMENT",
      );
    }
    const permittedChain = {
      ...chain,
      candidateChain: permittedCandidateChain,
      targets: permittedTargets,
    };
    const geminiTargets = permittedChain.targets.filter((t) => t.kind === "gemini");
    if (geminiTargets.length === 0) {
      return errorJson(
        c,
        400,
        `model '${parsed.data.model}' is an OpenAI image model — use POST /v1/images/generations`,
        "INVALID_ARGUMENT",
      );
    }

    // 5b) Per-key usage-budget gate (docs/06) — ONCE, before the chain runs.
    if (deps.budgetGate !== undefined && identity.caps?.budget !== undefined) {
      const check = await deps.budgetGate.check({
        keyId: identity.keyId,
        caps: identity.caps.budget,
        nowMs: Date.now(),
      });
      if (check.overBudget && check.behavior === "reject") {
        return errorJson(c, 429, "usage budget exceeded", "RESOURCE_EXHAUSTED");
      }
    }

    // 6) Run the gemini chain. Each attempt translates → generateContent, forwards via
    //    nativePassthrough, and maps the inlineData response → the interactions shape.
    const attempt: ImageAttempt = async (target: ImageChainTarget) => {
      let upstreamRequestJson: string | null = null;
      const captureUpstream = (b: string) => {
        upstreamRequestJson = b;
      };
      const native = (await target.client.nativePassthrough?.(
        {
          model: target.providerModel,
          contents: inputToContents(parsed.data.input),
          generationConfig: buildGenerationConfig(
            parsed.data.response_format ?? null,
            parsed.data.generation_config ?? null,
          ),
        },
        { signal: requestSignal(c), captureUpstream },
      )) as Record<string, unknown>;
      const interactionsBody = nativeToInteractions(native, `int_${requestId}`);
      const usageBody = usageBodyFromNative(native);
      return {
        clientBody: interactionsBody,
        usage: usageBody.usage,
        cost: deps.costOf(target.alias, usageBody),
        upstreamRequestJson,
      };
    };

    const outcome = await runImageChain(geminiTargets, deps.breaker, attempt, requestSignal(c));

    // 6b) Terminal failure. A client abort is a NON-provider fault → no record.
    if (!outcome.ok) {
      if (outcome.aborted) return errorJson(c, 400, "client disconnected", "CANCELLED");
      if (deps.record !== undefined) {
        const decision = buildImageDecision({
          requestId,
          traceId,
          keyPrefix,
          requested: parsed.data.model,
          selectedLane: permittedChain.laneName,
          candidateChain: permittedChain.candidateChain,
          attempts: outcome.attempts,
          served: null,
          finalErrorClass: outcome.errorClass,
          usage: null,
        });
        await recordServed(
          deps.record,
          {
            requestId,
            apiKeyId: identity.keyId,
            decision,
            requestJson,
            responseJson: null,
            timedOut: requestTimedOut(c),
            upstreamRequestJson: null,
          },
          log,
        );
      }
      return errorJson(
        c,
        outcome.httpStatus as ContentfulStatusCode,
        outcome.message,
        geminiStatusFor(outcome.errorClass),
      );
    }

    // 7) Cost + telemetry. Capture a copy with the base64 image stripped.
    const { served, result } = outcome;
    if (deps.record !== undefined) {
      const decision = buildImageDecision({
        requestId,
        traceId,
        keyPrefix,
        requested: parsed.data.model,
        selectedLane: permittedChain.laneName,
        candidateChain: permittedChain.candidateChain,
        attempts: outcome.attempts,
        served: { alias: served.alias, providerModel: served.providerModel },
        finalErrorClass: null,
        usage: result.usage,
      });
      // Capture the FULL body — the store's externalizeImages content-addresses the
      // base64 image into payload_blobs (deduped + retention-pruned) and rehydrates it
      // for the admin detail view; request_payloads keeps only a sentinel.
      const responseJson = captureEnabled(deps.record) ? JSON.stringify(result.clientBody) : null;
      await recordServed(
        deps.record,
        {
          requestId,
          apiKeyId: identity.keyId,
          decision,
          requestJson,
          responseJson,
          timedOut: requestTimedOut(c),
          upstreamRequestJson: result.upstreamRequestJson,
        },
        log,
      );
    }

    // 7b) Settle the served usage against the per-key budget (docs/06). Fail-open.
    if (deps.settleBudget !== undefined && identity.caps?.budget !== undefined) {
      const tokens =
        (numField(result.usage, "input_tokens", "prompt_tokens") ?? 0) +
        (numField(result.usage, "output_tokens", "completion_tokens") ?? 0);
      try {
        await deps.settleBudget(
          identity.keyId,
          identity.caps.budget,
          { requests: 1, tokens, costUsd: result.cost },
          Date.now(),
        );
      } catch {
        log("budget.settle_failed");
      }
    }

    // 8) Observability headers + the interactions JSON (full image) to the client.
    c.header("x-helm-lane", permittedChain.laneName);
    c.header("x-helm-final-model", served.alias);
    c.header("x-helm-provider-model", served.providerModel);
    return c.json(result.clientBody);
  });
}
