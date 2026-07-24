import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  type CircuitBreaker,
  createBlockedModelMatcher,
} from "@helm/core";
import { ImageGenerationRequestSchema } from "@helm/shared";
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

// POST /v1/images/generations — OpenAI Images API (the gpt-image-* / DALL·E surface).
// A model-pinned endpoint distinct from the chat/messages/responses/gemini pipeline,
// but it DOES fall over across providers: the requested id may be a bare image model
// (a one-element chain) or an image LANE (one target per provider alias), and the
// route runs the resolved chain through runImageChain — same circuit-breaker +
// terminal/fallback rules as the chat executor, specialized to a single non-stream
// image call. PURE HTTP glue (principle 1): the upstream call + cost live in core.

export interface ImagesRouteDeps {
  rateLimiter?: GeminiRateLimiterPort;
  concurrencyGate?: ConcurrencyGatePort;
  /** Machine-derived request-body budget shared by every AI ingress surface. */
  memoryAdmission?: BodyMemoryAdmission;
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  /** Resolve the client id (bare model OR image lane) → the ordered provider chain.
   *  Both upstream KINDS ride through: `openai` → OpenAI Images API
   *  (client.imageGeneration); `gemini` → generateContent (client.nativePassthrough;
   *  the route translates the images request ↔ generateContent, inlineData ↔ b64_json). */
  resolveImageChain: ResolveImageChain;
  /** Per-alias circuit breaker — the SAME instance the chat executor uses, so an image
   *  provider's health is one shared view across the chat + image faces. */
  breaker: CircuitBreaker;
  /** Price the served upstream body at the SERVED alias's catalog pricing (resolveCostUsd). */
  costOf(alias: string, body: unknown): number | null;
  /** Per-key usage-budget gate + settle (docs/06) — the SAME instances the chat face
   *  uses. Omitted = no budget enforcement (test doubles). */
  budgetGate?: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  settleBudget?: (
    keyId: string,
    caps: BudgetCaps,
    usage: { requests: number; tokens: number; costUsd: number | null },
    nowMs: number,
  ) => Promise<void>;
  /** Telemetry + payload recorder. Omitted = record nothing (test doubles). */
  record?: RecordServedDeps;
}

function errorJson(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  type: string,
  message: string,
  code: string | null = null,
): Response {
  return c.json({ error: { message, type, code, param: null } }, status);
}

function extractBearer(auth: string | undefined): string | null {
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m?.[1] ?? null;
}

// Map a Gemini generateContent native response → the OpenAI Images shape, so the
// rest of the route (cost, telemetry, client response) is provider-uniform. Image
// parts (inlineData) become data[].b64_json; usageMetadata (candidatesTokenCount =
// the image's output tokens) becomes the OpenAI usage shape resolveCostUsd prices.
function mapGeminiToImages(native: Record<string, unknown>): Record<string, unknown> {
  const data: Array<{ b64_json: string }> = [];
  const candidates = Array.isArray(native.candidates) ? native.candidates : [];
  for (const cand of candidates) {
    const parts = (cand as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = (part as { inlineData?: { data?: unknown } }).inlineData;
      if (inline && typeof inline.data === "string") data.push({ b64_json: inline.data });
    }
  }
  const usageBody = geminiImageUsageBody((native.usageMetadata ?? {}) as Record<string, unknown>);
  return {
    created: 0,
    data,
    usage: usageBody.usage,
  };
}

export function registerImagesRoute(app: Hono<AppEnv>, deps: ImagesRouteDeps): void {
  app.use("/v1/images/generations", concurrencyReleaseGuard());
  app.use("/v1/images/generations", memoryAdmissionReleaseGuard());

  app.post("/v1/images/generations", async (c) => {
    // Production always receives both ids from createApp. The UUID fallback keeps
    // this route safely usable in isolated/headless Hono composition tests without
    // ever consulting a client header for the storage key.
    const requestId = c.get("request_id") ?? crypto.randomUUID();
    const traceId = c.get("trace_id") ?? requestId;
    const log = (msg: string) =>
      console.warn(JSON.stringify({ level: "warn", event: msg, trace_id: traceId }));

    // 1) Auth (Bearer — OpenAI clients).
    const identity = await deps.auth.resolve(extractBearer(c.req.header("Authorization")));
    if (identity === null) {
      return errorJson(
        c,
        401,
        "invalid_request_error",
        "missing or invalid API key",
        "invalid_api_key",
      );
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
          return errorJson(c, 429, "rate_limit_exceeded", `rate limit exceeded (${rl.limitedBy})`);
        }
      }
    }

    // 3) Concurrency overflow queue AFTER rate-limit; release rides the context for
    //    the concurrencyReleaseGuard middleware to free on exit.
    if (deps.concurrencyGate !== undefined) {
      const acquired = await deps.concurrencyGate.acquire({
        keyId: identity.keyId,
        limit: identity.caps?.concurrencyLimit ?? null,
        signal: requestSignal(c),
      });
      if (!acquired.ok) {
        if (acquired.reason === "unavailable") {
          return errorJson(c, 503, "server_error", "concurrency lease unavailable");
        }
        c.header("retry-after", String(acquired.retryAfterSeconds));
        return errorJson(
          c,
          429,
          "rate_limit_exceeded",
          acquired.reason === "queue_full"
            ? "concurrency queue is full"
            : "timed out waiting for a concurrency slot",
        );
      }
      c.set(
        "concurrency_signal",
        AbortSignal.any([requestSignal(c), acquired.signal ?? requestSignal(c)]),
      );
      c.set("concurrencyRelease", acquired.release);
    }

    // 4) Parse + validate. Malformed JSON / invalid body → 400 (client error).
    let requestJson = "";
    let raw: unknown;
    try {
      const admitted =
        deps.memoryAdmission === undefined
          ? null
          : await readAdmittedRequestBody(c.req.raw, deps.memoryAdmission);
      requestJson = admitted?.text ?? (await c.req.text());
      if (admitted !== null) c.set("requestMemoryRelease", admitted.release);
      raw = JSON.parse(requestJson);
    } catch (error) {
      if (error instanceof RequestAdmissionError) {
        if (error.status === 503) c.header("retry-after", "1");
        return errorJson(
          c,
          error.status,
          error.status === 413 ? "invalid_request_error" : "server_error",
          error.message,
          error.code,
        );
      }
      return errorJson(c, 400, "invalid_request_error", "malformed JSON request body");
    }
    const parsed = ImageGenerationRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return errorJson(
        c,
        400,
        "invalid_request_error",
        parsed.error.issues[0]?.message ?? "invalid image generation request",
      );
    }

    // 5) Resolve the model/lane → the ordered provider chain.
    const chain = deps.resolveImageChain(parsed.data.model);
    if (!chain.ok) {
      return chain.status === 404
        ? errorJson(
            c,
            404,
            "invalid_request_error",
            `model '${parsed.data.model}' is not a configured image model`,
            "model_not_found",
          )
        : errorJson(
            c,
            503,
            "api_error",
            `image provider for '${parsed.data.model}' is unavailable (missing credential)`,
            "provider_unavailable",
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
        "invalid_request_error",
        directBlocked
          ? `model '${parsed.data.model}' is blocked for this key`
          : `all image candidate models for '${parsed.data.model}' are blocked for this key`,
        "model_blocked",
      );
    }
    const permittedChain = {
      ...chain,
      candidateChain: permittedCandidateChain,
      targets: permittedTargets,
    };

    // 5b) Per-key usage-budget gate (docs/06), mirroring the chat face — ONCE, before
    //     the chain runs (a fallback within one request is still one billable image).
    if (deps.budgetGate !== undefined && identity.caps?.budget !== undefined) {
      const check = await deps.budgetGate.check({
        keyId: identity.keyId,
        caps: identity.caps.budget,
        nowMs: Date.now(),
      });
      if (check.overBudget && check.behavior === "reject") {
        return errorJson(c, 429, "rate_limit_exceeded", "usage budget exceeded");
      }
    }

    // 6) Run the provider chain. Each attempt forwards verbatim (openai-kind) or
    //    translates to generateContent (gemini-kind), producing an OpenAI-Images body.
    const attempt: ImageAttempt = async (target: ImageChainTarget) => {
      let upstreamRequestJson: string | null = null;
      const captureUpstream = (b: string) => {
        upstreamRequestJson = b;
      };
      let upstream: Record<string, unknown>;
      if (target.kind === "gemini") {
        const native = await target.client.nativePassthrough?.(
          {
            model: target.providerModel,
            contents: [{ role: "user", parts: [{ text: parsed.data.prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          },
          { signal: requestSignal(c), captureUpstream },
        );
        upstream = mapGeminiToImages((native ?? {}) as Record<string, unknown>);
      } else {
        upstream = (await target.client.imageGeneration?.(
          { ...parsed.data, model: target.providerModel },
          { signal: requestSignal(c), captureUpstream },
        )) as Record<string, unknown>;
      }
      const usage = (upstream as { usage?: Record<string, unknown> }).usage ?? null;
      return {
        clientBody: upstream,
        usage,
        cost: deps.costOf(target.alias, upstream),
        upstreamRequestJson,
      };
    };

    const outcome = await runImageChain(
      permittedChain.targets,
      deps.breaker,
      attempt,
      requestSignal(c),
    );

    // 6b) Terminal failure. A client abort is a NON-provider fault → no record, no 5xx.
    if (!outcome.ok) {
      if (outcome.aborted) return errorJson(c, 400, "invalid_request_error", "client disconnected");
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
        "upstream_error",
        outcome.message,
      );
    }

    // 7) Cost + telemetry. Capture the response body (image stripped) only when on.
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
      // Capture the FULL body — the store's externalizeImages (payload-blobs.ts)
      // content-addresses the base64 image into payload_blobs (deduped + retention-
      // pruned) and rehydrates it for the admin detail view. request_payloads keeps
      // only a sentinel, so it stays lean while the image stays viewable.
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

    // 7b) Settle the served usage against the per-key budget (docs/06) — ONCE, on the
    //     SERVED target's cost. Fail-open: a settle failure is logged, never 5xx's.
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

    // 8) Observability headers + the VERBATIM upstream body (full image) to the client.
    c.header("x-helm-lane", permittedChain.laneName);
    c.header("x-helm-final-model", served.alias);
    c.header("x-helm-provider-model", served.providerModel);
    return c.json(result.clientBody);
  });
}
