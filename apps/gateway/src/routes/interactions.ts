import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  type ProviderClient,
  UpstreamError,
} from "@helm/core";
import { type InteractionInputBlock, InteractionsRequestSchema } from "@helm/shared";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { type ConcurrencyGatePort, concurrencyReleaseGuard } from "../middleware/concurrency.js";
import { estimateRequestTokens } from "../middleware/estimate-tokens.js";
import type { GeminiRateLimiterPort } from "./gemini.js";
import { buildImageDecision, numField } from "./image-telemetry.js";
import type { MessagesIdentity } from "./messages.js";
import { captureEnabled, type RecordServedDeps, recordServed } from "./payload-capture.js";

// POST /v1beta/interactions — Google Gemini Interactions API (the modern image-gen
// surface for the gemini-*-image "Nano Banana" models; the SDK's
// `client.interactions.create(...)`). A dedicated, model-pinned endpoint.
//
// Helm's upstream (ZenMux Vertex) speaks `generateContent`, NOT `/v1beta/interactions`,
// so this route TRANSLATES: the interactions request → a generateContent call
// (responseModalities IMAGE) forwarded verbatim via the provider's nativePassthrough,
// then the generateContent `inlineData` response → the interactions `steps` shape the
// Gemini SDK expects (`interaction.output_image.data` reads the image content block).
//
// PURE HTTP glue (principle 1): the upstream call + cost live in core; this route only
// does the protocol shape mapping + records ONE telemetry row (lane `image`).

export interface InteractionsRouteDeps {
  rateLimiter?: GeminiRateLimiterPort;
  concurrencyGate?: ConcurrencyGatePort;
  auth: { resolve(credential: string | null): Promise<MessagesIdentity | null> };
  /** SAME resolver the /v1/images/generations route uses. Returns the provider client +
   *  wire model + alias + KIND. This route only serves `gemini`-kind targets (it
   *  translates to generateContent); an `openai`-kind model (gpt-image-2) is rejected
   *  with 400 → use /v1/images/generations. */
  resolveImageTarget(
    model: string,
  ):
    | { client: ProviderClient; providerModel: string; alias: string; kind: "openai" | "gemini" }
    | { kind: "unavailable" }
    | null;
  /** Price the served body at the alias's catalog pricing (resolveCostUsd). */
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

// interactions `response_format` → generateContent `generationConfig`. Always request
// IMAGE output; map aspect_ratio / image_size to imageConfig (best-effort — passed
// through for the upstream to honour; absent keys are simply omitted).
function buildGenerationConfig(responseFormat: unknown): Record<string, unknown> {
  const cfg: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
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
  const um = (native.usageMetadata ?? {}) as Record<string, unknown>;
  const inputTokens = typeof um.promptTokenCount === "number" ? um.promptTokenCount : undefined;
  const outputTokens =
    typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : undefined;
  return {
    usage: {
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined
        ? { output_tokens: outputTokens, output_tokens_details: { image_tokens: outputTokens } }
        : {}),
    },
  };
}

// Capture-only clone with the base64 image stripped — the megabyte payload must never
// hit request_payloads (DB-bloat guard). The CLIENT still gets the full image.
function stripInteractionData(body: Record<string, unknown>): Record<string, unknown> {
  const steps = body.steps;
  if (!Array.isArray(steps)) return body;
  return {
    ...body,
    steps: steps.map((s) => {
      const step = s as { content?: unknown };
      if (!Array.isArray(step.content)) return s;
      return {
        ...step,
        content: step.content.map((blk) => {
          const b = blk as Record<string, unknown>;
          return b.type === "image" && typeof b.data === "string"
            ? { ...b, data: "[image omitted]" }
            : blk;
        }),
      };
    }),
  };
}

export function registerInteractionsRoute(app: Hono<AppEnv>, deps: InteractionsRouteDeps): void {
  app.use("/v1beta/interactions", concurrencyReleaseGuard());

  app.post("/v1beta/interactions", async (c) => {
    const traceId = crypto.randomUUID();
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
        signal: c.req.raw.signal,
      });
      if (!acquired.ok) {
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
      c.set("concurrencyRelease", acquired.release);
    }

    // 4) Parse + validate.
    let requestJson = "";
    let raw: unknown;
    try {
      requestJson = await c.req.text();
      raw = JSON.parse(requestJson);
    } catch {
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

    // 5) Resolve the model → provider. Only gemini-kind is served here.
    const target = deps.resolveImageTarget(parsed.data.model);
    if (target === null) {
      return errorJson(
        c,
        404,
        `model '${parsed.data.model}' is not a configured image model`,
        "NOT_FOUND",
      );
    }
    if (target.kind === "unavailable") {
      return errorJson(
        c,
        503,
        `image provider for '${parsed.data.model}' is unavailable (missing credential)`,
        "UNAVAILABLE",
      );
    }
    if (target.kind !== "gemini") {
      return errorJson(
        c,
        400,
        `model '${parsed.data.model}' is an OpenAI image model — use POST /v1/images/generations`,
        "INVALID_ARGUMENT",
      );
    }

    // 5b) Per-key usage-budget gate (docs/06), mirroring the chat face. A `degrade` key
    //     still SERVES (no cheaper image lane to fall to); cost is settled below either way.
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

    // 6) Translate → generateContent, forward via nativePassthrough, map back.
    let upstreamRequestJson: string | null = null;
    const started = Date.now();
    let native: Record<string, unknown>;
    const capture = (b: string) => {
      upstreamRequestJson = b;
    };
    try {
      if (typeof target.client.nativePassthrough !== "function") {
        return errorJson(c, 503, "image provider has no native passthrough", "UNAVAILABLE");
      }
      native = await target.client.nativePassthrough(
        {
          model: target.providerModel,
          contents: inputToContents(parsed.data.input),
          generationConfig: buildGenerationConfig(parsed.data.response_format ?? null),
        },
        { signal: c.req.raw.signal, captureUpstream: capture },
      );
    } catch (err) {
      const aborted =
        c.req.raw.signal.aborted || (err instanceof Error && err.name === "AbortError");
      const latency = Date.now() - started;
      const errorClass = err instanceof UpstreamError ? err.errorClass : "upstream_error";
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
      if (aborted) return errorJson(c, 400, "client disconnected", "CANCELLED");
      const status = (err instanceof UpstreamError ? err.httpStatus : 500) as ContentfulStatusCode;
      return errorJson(
        c,
        status,
        err instanceof Error ? err.message : "upstream error",
        "INTERNAL",
      );
    }

    // 7) Cost + telemetry. Build the interactions response; capture a copy with the
    //    base64 image stripped to a placeholder.
    const latency = Date.now() - started;
    const interactionsBody = nativeToInteractions(native, `int_${traceId}`);
    const usageBody = usageBodyFromNative(native);
    const cost = deps.costOf(target.alias, usageBody);
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
        usage: usageBody.usage,
      });
      const responseJson = captureEnabled(deps.record)
        ? JSON.stringify(stripInteractionData(interactionsBody))
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

    // 7b) Settle the served usage against the per-key budget (docs/06). Fail-open.
    if (deps.settleBudget !== undefined && identity.caps?.budget !== undefined) {
      const tokens =
        (numField(usageBody.usage, "input_tokens", "prompt_tokens") ?? 0) +
        (numField(usageBody.usage, "output_tokens", "completion_tokens") ?? 0);
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

    // 8) Observability headers + the interactions JSON (full image) to the client.
    c.header("x-helm-lane", "image");
    c.header("x-helm-final-model", target.alias);
    c.header("x-helm-provider-model", target.providerModel);
    return c.json(interactionsBody);
  });
}
