import {
  type BudgetCaps,
  type BudgetCheckResult,
  type BudgetProbe,
  createBlockedModelMatcher,
  type InsertTelemetryInput,
  JevError,
  type KeyStore,
  ResponseBodyTooLargeError,
  ResponseWorkCapacityError,
  readResponseTextWithinBudget,
} from "@helm/core";
import {
  type DecisionsRequest,
  DecisionsRequestSchema,
  type DecisionsResponse,
} from "@helm/shared";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ConcurrencyGatePort, concurrencyMiddleware } from "../middleware/concurrency.js";
import { requestSignal } from "../middleware/limits.js";
import { type RateLimiterPort, rateLimitMiddleware } from "../middleware/rate-limit.js";
import { buildImageDecision } from "./image-telemetry.js";

export interface DecisionsRouteDeps {
  keyStore: Pick<KeyStore, "getByHash">;
  invoke: (input: DecisionsRequest, signal: AbortSignal) => Promise<DecisionsResponse>;
  rateLimiter: RateLimiterPort;
  concurrencyGate: ConcurrencyGatePort;
  budgetGate: { check(probe: BudgetProbe): Promise<BudgetCheckResult> };
  reserveRequest: (keyId: string, caps: BudgetCaps, nowMs: number) => Promise<boolean>;
  // Only metadata reaches this port. Never use recordServed: failures force body capture.
  audit: (input: InsertTelemetryInput) => Promise<unknown>;
  timeoutMs?: number;
}

declare module "hono" {
  interface ContextVariableMap {
    decisions: {
      input?: DecisionsRequest;
      bytes: number;
      result?: DecisionsResponse;
      startedAt?: number;
      error?: string;
    };
  }
}
function fail(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string) {
  const state = c.get("decisions");
  if (state) state.error = code;
  return c.json({ error: { code, message }, trace_id: c.get("trace_id") }, status);
}

/** Separate protocol surface: no chat translation, memory injection, fallback or content capture. */
export function registerDecisionsRoute(app: Hono<AppEnv>, deps: DecisionsRouteDeps): void {
  const path = "/v1/decisions";
  app.use(path, async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  app.use(path, authMiddleware({ keyStore: deps.keyStore, log: () => {} }));
  app.use(path, async (c, next) => {
    c.set("decisions", { bytes: 0 });
    try {
      await next();
    } catch {
      c.res = fail(c, 503, "decisions_unavailable", "Decisions admission unavailable");
    }
    const state = c.get("decisions");
    const identity = c.get("identity");
    const result = state.result;
    const model = state.input?.model ?? "jev";
    const ok = c.res.status === 200 && result !== undefined;
    const error = ok ? null : (state.error ?? `http_${c.res.status}`);
    const decision = buildImageDecision({
      requestId: c.get("request_id"),
      traceId: c.get("trace_id"),
      keyPrefix: identity.keyPrefix,
      requested: model,
      selectedLane: "decisions",
      candidateChain: [model],
      attempts:
        state.startedAt === undefined
          ? []
          : [
              {
                alias: model,
                skipped: false,
                skip_reason: null,
                status: ok ? "ok" : "error",
                error_class: error,
                latency_ms: Date.now() - state.startedAt,
                cost_usd: result?.usage.cost ?? null,
                error_detail: null,
                provider_name: "openrouter",
                provider_model: result?.model ?? model,
              },
            ],
      served: ok ? { alias: model, providerModel: result.model } : null,
      finalErrorClass: error,
      usage: result
        ? {
            prompt_tokens: result.usage.input_tokens,
            completion_tokens: result.usage.output_tokens,
          }
        : null,
      policyReason: "jev_decisions",
    });
    decision.request_content_mode = "none";
    decision.request_body_bytes = state.bytes;
    try {
      await deps.audit({ decision, apiKeyId: identity.keyId, createdAt: new Date() });
    } catch {
      c.get("logger").log("error", "decisions.audit_failed", { trace_id: c.get("trace_id") });
    }
  });
  // Count the actual stream (including dishonest/missing Content-Length), using the shared
  // bounded reader and runtime memory admission. No raw body enters a persistence callback.
  app.use(path, async (c, next) => {
    let raw: unknown;
    try {
      const text = await readResponseTextWithinBudget(
        new Response(c.req.raw.body, {
          headers: { "content-length": c.req.header("content-length") ?? "" },
        }),
        32_000,
        undefined,
        requestSignal(c),
      );
      c.get("decisions").bytes = Buffer.byteLength(text, "utf8");
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      if (requestSignal(c).aborted)
        return fail(
          c,
          (c.req.raw.signal.aborted ? 499 : 504) as ContentfulStatusCode,
          "request_aborted",
          "Decisions body read aborted",
        );
      if (error instanceof ResponseBodyTooLargeError)
        return fail(c, 413, "input_too_large", "Decisions body exceeds 32000 bytes");
      if (error instanceof ResponseWorkCapacityError)
        return fail(c, 503, "server_overloaded", "Decisions memory admission unavailable");
      if (error instanceof SyntaxError)
        return fail(c, 400, "invalid_request", "Invalid Decisions JSON");
      throw error;
    }
    const parsed = DecisionsRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(c, 400, "invalid_request", "Invalid Decisions request");
    c.get("decisions").input = parsed.data;
    await next();
  });
  app.use(
    path,
    rateLimitMiddleware({
      limiter: deps.rateLimiter,
      // Conservative pre-debit, independent of caller-supplied Content-Length.
      estimateTokens: (c) => c.get("decisions").bytes,
    }),
  );
  app.use(path, concurrencyMiddleware(deps.concurrencyGate));
  app.post(path, async (c) => {
    const state = c.get("decisions");
    const input = state.input;
    if (!input) return fail(c, 400, "invalid_request", "Invalid Decisions request");
    const identity = c.get("identity");
    const caps = identity.caps;
    const blocked = createBlockedModelMatcher(caps.blockedModels);
    // Mutable aliases cannot prove a version-specific deny rule before incurring a charge.
    const mutableWithBlocks = blocked !== null && !/-\d{8}$/.test(input.model);
    const unversioned = input.model.replace(/-\d{8}$/, "");
    const models = [input.model, unversioned].flatMap((m) => [
      m,
      `openrouter/${m}`,
      m.split("/").at(-1) ?? m,
    ]);
    if (!caps.allowCustomModel || mutableWithBlocks || models.some((m) => blocked?.matches(m))) {
      return fail(c, 403, "model_not_allowed", "Jev model is not permitted for this key");
    }
    // No trustworthy pre-call token/cost bound. Never settle unknown usage as zero against a cap.
    if (caps.budget.tokens !== null || caps.budget.spendUsd !== null) {
      return fail(
        c,
        422,
        "metering_unavailable",
        "Decisions requires a key without token or spend budgets",
      );
    }
    try {
      const check = await deps.budgetGate.check({
        keyId: identity.keyId,
        caps: caps.budget,
        nowMs: Date.now(),
      });
      if (check.overBudget)
        return fail(
          c,
          429,
          "budget_exceeded",
          "Usage budget exceeded; Decisions cannot degrade to chat",
        );
      // Atomic pre-dispatch reservation; upstream failures remain charged as attempts.
      if (!(await deps.reserveRequest(identity.keyId, caps.budget, Date.now()))) {
        return fail(c, 429, "budget_exceeded", "Usage budget exceeded");
      }
    } catch {
      return fail(c, 503, "budget_unavailable", "Decisions budget unavailable");
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(deps.timeoutMs ?? 30_000, 30_000)));
    const signal = AbortSignal.any([requestSignal(c), timeout]);
    state.startedAt = Date.now();
    try {
      signal.throwIfAborted();
      const result = await deps.invoke(input, signal);
      signal.throwIfAborted();
      state.result = result;
      return c.json({
        ...result,
        requested_model: input.model,
        trace_id: c.get("trace_id"),
        request_id: c.get("request_id"),
        content_retention: "none",
      });
    } catch (error) {
      if (signal.aborted) {
        const clientAborted = c.req.raw.signal.aborted;
        return fail(
          c,
          (clientAborted ? 499 : 504) as ContentfulStatusCode,
          clientAborted ? "client_aborted" : "timeout",
          clientAborted ? "Client disconnected" : "Decisions request timed out",
        );
      }
      const status =
        error instanceof JevError && [400, 413, 422, 429, 503].includes(error.status)
          ? (error.status as ContentfulStatusCode)
          : 502;
      return fail(c, status, "jev_upstream_error", "Jev Decisions request failed");
    }
  });
}
