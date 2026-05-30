import type {
  CircuitBreaker,
  ExecuteOutcome,
  ExecutionPlan,
  ProviderClient,
  ProviderRegistry,
  RouteProviderAttempt,
} from "@helm/core";
import { checkCapability, UpstreamError } from "@helm/core";
import type { CatalogEntry, InternalRequest } from "@helm/shared";
import { makeHelmError } from "@helm/shared";

// Gateway execution adapter — the `execute` injected into routeRequest. It walks
// the resolved candidate chain (ExecutionPlan.candidate_chain) honoring the
// EXECUTION-fallback rules (CLAUDE.md principle 5, docs/04):
//   resolve alias (registry) -> circuit breaker gate (OPEN => skip) ->
//   capability filter (incompatible => skip) -> provider invoke. First success
//   wins; failures BEFORE the first valid chunk record a breaker failure and try
//   the next candidate; a client abort is a NON-provider fault (no breaker
//   failure, terminates the chain); chain exhaustion => structured
//   `all_providers_failed`.
//
// Streaming (principle 8): for stream:true the provider stream is forwarded
// UNBUFFERED. We peek the FIRST chunk to decide success vs. pre-first-chunk
// failure (matching the breaker contract), then hand back a generator that
// re-emits that first chunk followed by the rest — byte-for-byte, in order.

export interface ExecuteAdapterDeps {
  provider: ProviderClient;
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  /** modelKey -> capabilities; missing entry => capability filter is skipped. */
  catalog: Map<string, CatalogEntry>;
  now: () => number;
  /** Abort signal for the current request (client disconnect). */
  signal: AbortSignal;
}

function approxPromptTokens(req: InternalRequest): number {
  // Cheap heuristic (no tokenizer at the gateway): ~4 chars/token over the
  // concatenated textual content. Good enough for the context-window gate.
  let chars = 0;
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") chars += part.length;
        else if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          chars += (part as { text: string }).text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

function errorClassOf(err: unknown): string {
  if (err instanceof UpstreamError) return err.errorClass;
  return "upstream_error";
}

// Build the `execute` callback bound to a single request's deps.
export function createExecute(deps: ExecuteAdapterDeps) {
  const { provider, registry, breaker, catalog, now, signal } = deps;

  return async function execute(
    plan: ExecutionPlan,
    req: InternalRequest,
  ): Promise<ExecuteOutcome> {
    const attempts: RouteProviderAttempt[] = [];

    for (const alias of plan.candidate_chain) {
      const startedAt = now();
      const elapsed = () => Math.max(0, now() - startedAt);

      // Resolve alias -> provider model. Unknown alias is a config gap; skip it
      // (fail-open: never substitute a different model silently).
      const resolved = registry.resolve(alias);
      const providerModel = resolved.ok ? resolved.value.providerModel : alias;

      // 1) Circuit breaker gate.
      const gate = breaker.canAttempt(providerModel);
      if (!gate.allow) {
        attempts.push(skipRow(alias, gate.reason ?? "circuit_open", elapsed()));
        continue;
      }

      // 2) Capability filter (only when we have catalog data for the model).
      const caps = catalog.get(providerModel)?.capabilities;
      if (caps) {
        const verdict = checkCapability(caps, {
          needsTools: Array.isArray(req.tools) && req.tools.length > 0,
          needsJson: isJson(req.response_format),
          needsVision: Array.isArray(req.attachments) && req.attachments.length > 0,
          needsStreaming: req.stream,
          estimatedPromptTokens: approxPromptTokens(req),
          maxTokens: req.max_tokens,
        });
        if (!verdict.ok) {
          attempts.push(skipRow(alias, verdict.skipReason ?? "capability", elapsed()));
          continue;
        }
      }

      // 3) Invoke the provider (stream or non-stream). We send the RESOLVED
      //    provider model (not the originally-requested alias) — the gateway
      //    picked this model, so the upstream must be told which one to run.
      try {
        if (req.stream) {
          const stream = await peekStream(provider, req, signal, providerModel);
          breaker.recordSuccess(providerModel);
          attempts.push(okRow(alias, elapsed()));
          return {
            attempts,
            final: { status: "ok", alias, providerModel },
            body: null,
            stream,
          };
        }
        const bodyReq = stripInternal(req, providerModel);
        const body = await provider.chatCompletion(bodyReq, { signal });
        breaker.recordSuccess(providerModel);
        attempts.push(okRow(alias, elapsed()));
        return {
          attempts,
          final: { status: "ok", alias, providerModel },
          body,
          stream: null,
        };
      } catch (err) {
        // Client abort: non-provider fault. Terminate the chain WITHOUT marking a
        // breaker failure or counting it as all_providers_failed.
        if (isAbort(err, signal)) {
          breaker.recordAbort(providerModel);
          attempts.push({
            alias,
            skipped: false,
            skip_reason: "aborted",
            status: "error",
            error_class: "client_abort",
            latency_ms: elapsed(),
            cost_usd: null,
          });
          return {
            attempts,
            final: {
              status: "error",
              error: makeHelmError({
                error_class: "upstream_error",
                message: "client aborted request",
                trace_id: req.request_id,
              }),
            },
            body: null,
            stream: null,
          };
        }
        // Genuine pre-first-chunk failure: record on the breaker, try next.
        breaker.recordFailure(providerModel);
        attempts.push({
          alias,
          skipped: false,
          skip_reason: null,
          status: "error",
          error_class: errorClassOf(err),
          latency_ms: elapsed(),
          cost_usd: null,
        });
      }
    }

    // Chain exhausted (or empty) — the ONLY place all_providers_failed surfaces.
    const errorClass =
      plan.candidate_chain.length === 0 ? "lane_unavailable" : "all_providers_failed";
    return {
      attempts,
      final: {
        status: "error",
        error: makeHelmError({
          error_class: errorClass,
          message:
            errorClass === "lane_unavailable"
              ? "lane has no candidates"
              : "all providers in the candidate chain failed",
          trace_id: req.request_id,
        }),
      },
      body: null,
      stream: null,
    };
  };
}

// Open the provider stream and peek the first chunk so a pre-first-chunk failure
// (connect/handshake/upstream 5xx) rejects HERE (breaker contract), while a
// healthy stream is re-emitted intact — first chunk then the remainder.
async function peekStream(
  provider: ProviderClient,
  req: InternalRequest,
  signal: AbortSignal,
  providerModel: string,
): Promise<AsyncIterable<string>> {
  const iterable = provider.chatCompletionStream(stripInternal(req, providerModel), { signal });
  const iterator = iterable[Symbol.asyncIterator]();
  const first = await iterator.next(); // may throw (pre-first-chunk failure)

  return (async function* relay(): AsyncGenerator<string> {
    if (!first.done && first.value !== undefined) yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value !== undefined) yield next.value;
    }
  })();
}

// Project the InternalRequest back to an OpenAI-compatible body for the upstream
// passthrough provider. (Protocol re-emit is the docs/05 tasks; here the loose
// normalized shape maps 1:1.)
function stripInternal(req: InternalRequest, providerModel: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: providerModel,
    messages: req.messages,
    stream: req.stream,
  };
  if (req.tools) body.tools = req.tools;
  if (req.response_format) body.response_format = req.response_format;
  if (req.max_tokens !== null) body.max_tokens = req.max_tokens;
  return body;
}

function isJson(rf: InternalRequest["response_format"]): boolean {
  if (!rf || typeof rf !== "object") return false;
  const t = (rf as { type?: unknown }).type;
  return t === "json_object" || t === "json_schema";
}

function skipRow(alias: string, reason: string, latencyMs: number): RouteProviderAttempt {
  return {
    alias,
    skipped: true,
    skip_reason: reason,
    status: "error",
    error_class: null,
    latency_ms: latencyMs,
    cost_usd: null,
  };
}

function okRow(alias: string, latencyMs: number): RouteProviderAttempt {
  return {
    alias,
    skipped: false,
    skip_reason: null,
    status: "ok",
    error_class: null,
    latency_ms: latencyMs,
    cost_usd: null,
  };
}
