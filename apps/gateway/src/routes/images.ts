import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  type CircuitBreaker,
  createBlockedModelMatcher,
  type ImageEditInput,
} from "@helm/core";
import { ImageEditRequestSchema, ImageGenerationRequestSchema } from "@helm/shared";
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
  for (const path of ["/v1/images/generations", "/v1/images/edits"]) {
    app.use(path, concurrencyReleaseGuard());
    app.use(path, memoryAdmissionReleaseGuard());
  }

  const handle = async (c: Context<AppEnv>): Promise<Response> => {
    const editing = c.req.path === "/v1/images/edits";
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

    // 4) Parse + validate. Edits support both the Codex JSON carrier and the public
    // multipart carrier. The admitted bytes make multipart fallback attempts replayable.
    let requestJson = "";
    let model = "";
    let prompt = "";
    let generationBody: Record<string, unknown> | null = null;
    let editInput: ImageEditInput | null = null;
    try {
      const admitted =
        deps.memoryAdmission === undefined
          ? null
          : await readAdmittedRequestBody(c.req.raw, deps.memoryAdmission);
      const bytes = admitted?.bytes ?? new Uint8Array(await c.req.arrayBuffer());
      requestJson = admitted?.text ?? Buffer.from(bytes).toString("utf8");
      if (admitted !== null) c.set("requestMemoryRelease", admitted.release);
      const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
      if (editing && contentType.startsWith("multipart/form-data")) {
        const form = await new Request("http://helm.internal/v1/images/edits", {
          method: "POST",
          headers: { "content-type": c.req.header("Content-Type") ?? "" },
          body: Buffer.from(bytes),
        }).formData();
        const fields: ImageEditInput & { kind: "multipart" } = {
          kind: "multipart",
          fields: await Promise.all(
            [...form.entries()].map(async ([name, value]) =>
              typeof value === "string"
                ? { name, value }
                : {
                    name,
                    value: new Uint8Array(await value.arrayBuffer()),
                    filename: value.name,
                    contentType: value.type || "application/octet-stream",
                  },
            ),
          ),
        };
        model = form.get("model")?.toString().trim() ?? "";
        prompt = form.get("prompt")?.toString().trim() ?? "";
        const hasImage = fields.fields.some(
          (field) =>
            (field.name === "image" || field.name === "image[]") &&
            typeof field.value !== "string" &&
            field.value.byteLength > 0,
        );
        if (model.length === 0 || prompt.length === 0 || !hasImage) {
          return errorJson(
            c,
            400,
            "invalid_request_error",
            "multipart image edit requires model, prompt, and at least one image file",
          );
        }
        editInput = fields;
        requestJson = JSON.stringify({
          model,
          prompt,
          files: fields.fields
            .filter((field) => typeof field.value !== "string")
            .map((field) => ({
              name: field.name,
              filename: "filename" in field ? field.filename : "",
            })),
        });
      } else {
        const raw = JSON.parse(requestJson) as unknown;
        const parsed = (editing ? ImageEditRequestSchema : ImageGenerationRequestSchema).safeParse(
          raw,
        );
        if (!parsed.success) {
          return errorJson(
            c,
            400,
            "invalid_request_error",
            parsed.error.issues[0]?.message ??
              `invalid image ${editing ? "edit" : "generation"} request`,
          );
        }
        model = parsed.data.model;
        prompt = parsed.data.prompt;
        if (editing) editInput = { kind: "json", body: parsed.data };
        else generationBody = parsed.data;
      }
      admitted?.materialized();
    } catch (error) {
      if (error instanceof RequestAdmissionError) {
        c.header("retry-after", "1");
        return errorJson(c, error.status, "server_error", error.message, error.code);
      }
      return errorJson(c, 400, "invalid_request_error", "malformed image request body");
    }

    // 5) Resolve the model/lane → the ordered provider chain.
    const chain = deps.resolveImageChain(model);
    if (!chain.ok) {
      return chain.status === 404
        ? errorJson(
            c,
            404,
            "invalid_request_error",
            `model '${model}' is not a configured image model`,
            "model_not_found",
          )
        : errorJson(
            c,
            503,
            "api_error",
            `image provider for '${model}' is unavailable (missing credential)`,
            "provider_unavailable",
          );
    }
    const operationTargets = editing
      ? chain.targets.filter(
          (target) => target.kind === "openai" && typeof target.client.imageEdit === "function",
        )
      : chain.targets;
    if (operationTargets.length === 0) {
      return errorJson(
        c,
        400,
        "invalid_request_error",
        `model '${model}' does not support image edits`,
        "unsupported_operation",
      );
    }
    const blockedModels = createBlockedModelMatcher(identity.caps?.blockedModels);
    const permittedTargets =
      blockedModels === null
        ? operationTargets
        : operationTargets.filter((target) => !blockedModels.matches(target.alias));
    const permittedCandidateChain =
      blockedModels === null
        ? operationTargets.map((target) => target.alias)
        : operationTargets
            .map((target) => target.alias)
            .filter((alias) => !blockedModels.matches(alias));
    if (permittedTargets.length === 0) {
      const directBlocked = chain.laneName !== model && blockedModels?.matches(model) === true;
      return errorJson(
        c,
        400,
        "invalid_request_error",
        directBlocked
          ? `model '${model}' is blocked for this key`
          : `all image candidate models for '${model}' are blocked for this key`,
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
      if (editing) {
        if (!editInput || !target.client.imageEdit) {
          throw new Error("image edit provider is unavailable");
        }
        const providerInput: ImageEditInput =
          editInput.kind === "json"
            ? { kind: "json", body: { ...editInput.body, model: target.providerModel } }
            : {
                kind: "multipart",
                fields: editInput.fields.map((field) =>
                  field.name === "model" && typeof field.value === "string"
                    ? { name: field.name, value: target.providerModel }
                    : field,
                ),
              };
        upstream = await target.client.imageEdit(providerInput, {
          signal: requestSignal(c),
          captureUpstream,
        });
      } else if (target.kind === "gemini") {
        const native = await target.client.nativePassthrough?.(
          {
            model: target.providerModel,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          },
          { signal: requestSignal(c), captureUpstream },
        );
        upstream = mapGeminiToImages((native ?? {}) as Record<string, unknown>);
      } else {
        upstream = (await target.client.imageGeneration?.(
          { ...generationBody, model: target.providerModel },
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
          requested: model,
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
        outcome.errorClass === "invalid_request" ? "invalid_request_error" : "upstream_error",
        outcome.message,
        outcome.errorClass === "invalid_request" ? "invalid_request" : null,
      );
    }

    // 7) Cost + telemetry. Capture the response body (image stripped) only when on.
    const { served, result } = outcome;
    if (deps.record !== undefined) {
      const decision = buildImageDecision({
        requestId,
        traceId,
        keyPrefix,
        requested: model,
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
  };

  app.post("/v1/images/generations", handle);
  app.post("/v1/images/edits", handle);
}
