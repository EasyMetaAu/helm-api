import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  type ProviderClient,
  UpstreamError,
} from "@helm/core";
import { ImageGenerationRequestSchema } from "@helm/shared";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import type { GeminiRateLimiterPort } from "./gemini.js";
import { buildImageDecision, numField } from "./image-telemetry.js";
import type { MessagesIdentity } from "./messages.js";
import { captureEnabled, type RecordServedDeps, recordServed } from "./payload-capture.js";

// POST /v1/images/generations — OpenAI Images API (the gpt-image-* / DALL·E surface).
// A dedicated, model-pinned endpoint distinct from the chat/messages/responses/gemini
// pipeline (those are classify→lane→fallback; image gen has none of that). The route
// resolves the requested model to a provider, forwards the verbatim body to the
// provider's /images/generations, and records ONE telemetry row (so it shows in
// /admin/requests with cost). PURE HTTP glue (principle 1): the upstream call + cost
// live in core (the OpenAI provider's imageGeneration + resolveCostUsd).

export interface ImagesRouteDeps {
  rateLimiter?: GeminiRateLimiterPort;
  concurrencyGate?: ConcurrencyGatePort;
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  /** Resolve a client-facing model id → the provider client + wire model id + the
   *  routing alias (for pricing/telemetry) + the upstream KIND. null when the model
   *  is not a configured image model OR its provider lacks the needed method / credential.
   *  `openai`  → OpenAI Images API (client.imageGeneration → /images/generations).
   *  `gemini`  → Gemini generateContent (client.nativePassthrough; the route translates
   *              the images request ↔ generateContent and maps inlineData ↔ b64_json). */
  resolveImageTarget(model: string):
    | { client: ProviderClient; providerModel: string; alias: string; kind: "openai" | "gemini" }
    // Configured image model, but the provider client/credential is missing → 503
    // (a server-config problem, NOT a nonexistent-model client error).
    | { kind: "unavailable" }
    // Unknown model / not an image-capable provider → 404.
    | null;
  /** Price the served upstream body at the alias's catalog pricing (resolveCostUsd). */
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

// Capture-only clone with the ~1MB base64 image stripped — the request/response are
// captured for audit, but the megabyte payload must never hit request_payloads
// (operator DB-bloat guard). The CLIENT still receives the full image (the route
// responds with the verbatim upstream body, not this clone).
function stripImageData(body: Record<string, unknown>): Record<string, unknown> {
  const data = body.data;
  if (!Array.isArray(data)) return body;
  return {
    ...body,
    data: data.map((d) => {
      if (
        d !== null &&
        typeof d === "object" &&
        typeof (d as Record<string, unknown>).b64_json === "string"
      ) {
        return { ...(d as Record<string, unknown>), b64_json: "[image omitted]" };
      }
      return d;
    }),
  };
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
  const um = (native.usageMetadata ?? {}) as Record<string, unknown>;
  const inputTokens = typeof um.promptTokenCount === "number" ? um.promptTokenCount : undefined;
  const outputTokens =
    typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : undefined;
  return {
    created: 0,
    data,
    usage: {
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined
        ? { output_tokens: outputTokens, output_tokens_details: { image_tokens: outputTokens } }
        : {}),
    },
  };
}

export function registerImagesRoute(app: Hono<AppEnv>, deps: ImagesRouteDeps): void {
  app.use("/v1/images/generations", concurrencyReleaseGuard());

  app.post("/v1/images/generations", async (c) => {
    const traceId = crypto.randomUUID();
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
        signal: c.req.raw.signal,
      });
      if (!acquired.ok) {
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
      c.set("concurrencyRelease", acquired.release);
    }

    // 4) Parse + validate. Malformed JSON / invalid body → 400 (client error).
    let requestJson = "";
    let raw: unknown;
    try {
      requestJson = await c.req.text();
      raw = JSON.parse(requestJson);
    } catch {
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

    // 5) Resolve the model → provider + upstream kind.
    const target = deps.resolveImageTarget(parsed.data.model);
    if (target === null) {
      return errorJson(
        c,
        404,
        "invalid_request_error",
        `model '${parsed.data.model}' is not a configured image model`,
        "model_not_found",
      );
    }
    if (target.kind === "unavailable") {
      // Configured image model but the provider credential/client is missing — a
      // server-side config problem (e.g. ZENMUX_API_KEY unset), NOT a bad model id.
      return errorJson(
        c,
        503,
        "api_error",
        `image provider for '${parsed.data.model}' is unavailable (missing credential)`,
        "provider_unavailable",
      );
    }

    // 5b) Per-key usage-budget gate (docs/06), mirroring the chat face. Over budget +
    //     reject → 429. `degrade` has no meaning for a model-pinned image request (no
    //     cheaper image lane to fall to), so a degrade key still SERVES — its cost is
    //     settled below either way (so image spend still counts toward the budget).
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

    // 6) Forward — provider-kind specific — producing an OpenAI-Images-shaped `upstream`.
    let upstreamRequestJson: string | null = null;
    const started = Date.now();
    let upstream: Record<string, unknown>;
    const capture = (b: string) => {
      upstreamRequestJson = b;
    };
    try {
      if (target.kind === "gemini") {
        // Translate the images request → a Gemini generateContent call (responseModalities
        // IMAGE) via nativePassthrough, then map the inlineData response back to b64_json.
        if (typeof target.client.nativePassthrough !== "function") {
          return errorJson(c, 503, "api_error", "image provider has no native passthrough");
        }
        const native = await target.client.nativePassthrough(
          {
            model: target.providerModel,
            contents: [{ role: "user", parts: [{ text: parsed.data.prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          },
          { signal: c.req.raw.signal, captureUpstream: capture },
        );
        upstream = mapGeminiToImages(native);
      } else {
        if (typeof target.client.imageGeneration !== "function") {
          return errorJson(c, 503, "api_error", "image provider has no image generation");
        }
        upstream = await target.client.imageGeneration(
          { ...parsed.data, model: target.providerModel },
          { signal: c.req.raw.signal, captureUpstream: capture },
        );
      }
    } catch (err) {
      const aborted =
        c.req.raw.signal.aborted || (err instanceof Error && err.name === "AbortError");
      const latency = Date.now() - started;
      const errorClass = err instanceof UpstreamError ? err.errorClass : "upstream_error";
      // A client disconnect is NOT a provider fault → don't record, don't 5xx-as-provider.
      if (!aborted && deps.record !== undefined) {
        const decision = buildImageDecision({
          traceId,
          keyPrefix,
          requested: parsed.data.model,
          alias: target.alias,
          providerModel: target.providerModel,
          status: "error",
          errorClass,
          cost: null,
          latency,
          usage: null,
        });
        await recordServed(
          deps.record,
          {
            requestId: traceId,
            apiKeyId: identity.keyId,
            decision,
            requestJson,
            responseJson: null,
            upstreamRequestJson,
          },
          log,
        );
      }
      if (aborted) return errorJson(c, 400, "invalid_request_error", "client disconnected");
      const status = (err instanceof UpstreamError ? err.httpStatus : 500) as ContentfulStatusCode;
      return errorJson(
        c,
        status,
        "upstream_error",
        err instanceof Error ? err.message : "upstream error",
      );
    }

    // 7) Cost + telemetry. Always write the telemetry row; capture the response body
    //    only when capture is on, with the base64 image stripped to a placeholder.
    const latency = Date.now() - started;
    const cost = deps.costOf(target.alias, upstream);
    const usage = (upstream as { usage?: Record<string, unknown> }).usage ?? null;
    if (deps.record !== undefined) {
      const decision = buildImageDecision({
        traceId,
        keyPrefix,
        requested: parsed.data.model,
        alias: target.alias,
        providerModel: target.providerModel,
        status: "ok",
        errorClass: null,
        cost,
        latency,
        usage,
      });
      const responseJson = captureEnabled(deps.record)
        ? JSON.stringify(stripImageData(upstream))
        : null;
      await recordServed(
        deps.record,
        {
          requestId: traceId,
          apiKeyId: identity.keyId,
          decision,
          requestJson,
          responseJson,
          upstreamRequestJson,
        },
        log,
      );
    }

    // 7b) Settle the served usage against the per-key budget (docs/06). Fail-open: a
    //     settle failure is logged, never 5xx's a served image. Counts the image cost +
    //     tokens + 1 request so image spend depletes the budget like the chat face.
    if (deps.settleBudget !== undefined && identity.caps?.budget !== undefined) {
      const tokens =
        (numField(usage, "input_tokens", "prompt_tokens") ?? 0) +
        (numField(usage, "output_tokens", "completion_tokens") ?? 0);
      try {
        await deps.settleBudget(
          identity.keyId,
          identity.caps.budget,
          { requests: 1, tokens, costUsd: cost },
          Date.now(),
        );
      } catch {
        log("budget.settle_failed");
      }
    }

    // 8) Observability headers + the VERBATIM upstream body (full image) to the client.
    c.header("x-helm-lane", "image");
    c.header("x-helm-final-model", target.alias);
    c.header("x-helm-provider-model", target.providerModel);
    return c.json(upstream);
  });
}
