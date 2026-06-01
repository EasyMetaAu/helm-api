import type {
  CircuitBreaker,
  ExecuteOutcome,
  ExecutionPlan,
  ProviderClient,
  ProviderRegistry,
  RouteProviderAttempt,
} from "@helm/core";
import { checkCapability, computeCostUsd, UpstreamError, usageFromBody } from "@helm/core";
import type { AttemptErrorDetail, CatalogEntry, InternalRequest } from "@helm/shared";
import { makeHelmError } from "@helm/shared";

// Gateway execution adapter — the `execute` injected into routeRequest. It walks
// the resolved candidate chain (ExecutionPlan.candidate_chain) honoring the
// EXECUTION-fallback rules (CLAUDE.md principle 5, docs/04):
//   resolve alias (registry) -> pick the RESOLVED provider's client (so a chain
//   can CROSS providers) -> circuit breaker gate (OPEN => skip) -> capability
//   filter (incompatible => skip) -> provider invoke. First success wins;
//   failures BEFORE the first valid chunk record a breaker failure and try the
//   next candidate; a client abort is a NON-provider fault (no breaker failure,
//   terminates the chain); chain exhaustion => structured `all_providers_failed`.
//
// Multi-provider (providers-multi): each candidate alias resolves (via registry)
// to a provider name + upstream model id. The executor invokes THAT provider's
// client — so a fallback chain like [deepseek/.., openai/..] hits two different
// upstreams in order. When the alias is unknown to the registry, or no client is
// registered for the resolved provider, it falls back to `defaultProvider` (the
// Phase-0 single-provider passthrough: lane aliases map 1:1 to the one upstream).
//
// Streaming (principle 8): for stream:true the provider stream is forwarded
// UNBUFFERED. We peek the FIRST chunk to decide success vs. pre-first-chunk
// failure (matching the breaker contract), then hand back a generator that
// re-emits that first chunk followed by the rest — byte-for-byte, in order.

export interface ExecuteAdapterDeps {
  /** Default/fallback provider client: used for an unknown alias OR a resolved
   *  provider with no registered client (Phase-0 single-provider passthrough). */
  defaultProvider: ProviderClient;
  /** Per-provider clients keyed by provider NAME (registry providerName). When a
   *  candidate resolves to one of these, its client is used → chains cross
   *  providers. Optional: absent/empty => everything uses defaultProvider. */
  providers?: Map<string, ProviderClient>;
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  /** modelKey -> capabilities; missing entry => capability filter is skipped. */
  catalog: Map<string, CatalogEntry>;
  now: () => number;
  /** Abort signal for the current request (client disconnect). */
  signal: AbortSignal;
  /** Structured log sink (safe fields only — NEVER key/payload, principle 7).
   *  Optional: used to record a MISSING-pricing miss (cost left null, not a
   *  crash). Absent → the miss is silent. */
  log?: (level: string, msg: string, fields: Record<string, unknown>) => void;
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
  // Mirror executor/fallback isAbort: rely ONLY on signal.aborted and the raw
  // AbortError name. A message merely containing "aborted" is NOT an abort (an
  // upstream error string can say "aborted upstream"); openai.ts rethrows the
  // raw AbortError on a real client disconnect, so the name check is sufficient.
  if (signal.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

// :free candidates may be throttled (429) by the upstream's free tier. That is
// NOT a provider-health signal (principle 5), so it skips to the next candidate
// WITHOUT recording a breaker failure. Reads the real upstream status (not the
// client-facing httpStatus 502) added on UpstreamError.upstreamStatus.
function isFreeAlias(alias: string): boolean {
  return alias.endsWith(":free");
}

function upstreamStatusOf(err: unknown): number | null {
  return err instanceof UpstreamError ? err.upstreamStatus : null;
}

function errorClassOf(err: unknown): string {
  if (err instanceof UpstreamError) return err.errorClass;
  return "upstream_error";
}

// Coerce an already-scrubbed upstream error body into the schema's record|null
// shape. A plain object passes through; a primitive/array (e.g. an HTML or text
// error page) is wrapped so the detail is preserved, not silently dropped.
function toRawRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { raw };
}

// Build the redacted per-attempt error_detail (admin-debug-error-detail) from a
// genuine upstream failure. An UpstreamError carries the real upstream status,
// a message, and the key-scrubbed body; any other error degrades to its message
// with no status/body. The telemetry redact gate scrubs this again before it is
// persisted (principle 7), so a key echoed in the body never survives.
function errorDetailOf(err: unknown): AttemptErrorDetail {
  if (err instanceof UpstreamError) {
    return {
      upstream_status: err.upstreamStatus,
      message: err.message,
      provider_raw: toRawRecord(err.providerRaw),
    };
  }
  return {
    upstream_status: null,
    message: err instanceof Error ? err.message : String(err),
    provider_raw: null,
  };
}

// Build the `execute` callback bound to a single request's deps.
export function createExecute(deps: ExecuteAdapterDeps) {
  const { defaultProvider, providers, registry, breaker, catalog, now, signal, log } = deps;

  // Cost of one served attempt = provider usage × catalog pricing (docs/07).
  // Keyed by the candidate ALIAS — the catalog/pricing modelKey is the routing
  // alias (e.g. `openai-crs/gpt-5.4-mini`), NOT the bare upstream model id we send
  // on the wire (`gpt-5.4-mini`). See the resolve block below.
  // Missing pricing (no catalog entry, or a half-filled pricing row) → null
  // ("not measured", distinct from a measured 0) and a logged miss, NEVER a
  // crash (principle 3). Streaming attempts have no usage at peek time → null.
  const costOf = (alias: string, body: unknown): number | null => {
    const pricing = catalog.get(alias)?.pricing;
    const cost = computeCostUsd(pricing, usageFromBody(body));
    if (cost === null) {
      log?.("info", "cost.pricing_missing", { alias });
    }
    return cost;
  };

  return async function execute(
    plan: ExecutionPlan,
    req: InternalRequest,
  ): Promise<ExecuteOutcome> {
    const attempts: RouteProviderAttempt[] = [];
    // Chain-exhaustion bookkeeping so we can tell apart the two "nobody served"
    // outcomes (docs/07): a HARD capability mismatch (no candidate could ever
    // satisfy the request → capability_unsatisfiable / 422) vs. transient
    // provider failures (all_providers_failed / 502).
    //   • capabilityPruned — at least one candidate was skipped by the capability
    //     filter (known-incompatible).
    //   • attemptedAny — at least one candidate actually reached the upstream
    //     invoke (so a failure here is a provider fault, not a capability gap).
    //     A model with NO catalog entry is fail-open: it is attempted, so it
    //     counts here and never yields capability_unsatisfiable (don't over-prune).
    //   • circuitSkipped — at least one candidate was skipped only because its
    //     breaker was OPEN; that is a transient health signal, not a capability
    //     gap, so it must NOT be reported as capability_unsatisfiable.
    let capabilityPruned = false;
    let attemptedAny = false;
    let circuitSkipped = false;

    for (const alias of plan.candidate_chain) {
      const startedAt = now();
      const elapsed = () => Math.max(0, now() - startedAt);

      // Resolve alias -> { provider name, upstream model }. Two DISTINCT ids come
      // out and must not be conflated (fix-upstream-model-id 2026-05-31):
      //   • alias        — the ROUTING key. The catalog/pricing modelKey, the
      //     circuit-breaker key, and the decision-record id are ALL the alias
      //     (e.g. `openai-crs/gpt-5.4-mini`). This is what the rest of the system
      //     keys on; the generated catalog is keyed by it.
      //   • providerModel — the provider's REAL upstream model id (e.g.
      //     `gpt-5.4-mini`). The ONLY thing it is used for is the wire `model`
      //     field we send upstream. The relay rejects anything else with a 500.
      // An unknown alias is a config gap: keep the alias as the upstream model id
      // too and use the default provider (fail-open — never substitute a different
      // model silently). A resolved alias selects BOTH the upstream model id AND
      // the provider client (so the fallback chain can cross providers). When the
      // resolved provider has no registered client, fall back to the default too.
      const resolved = registry.resolve(alias);
      const providerModel = resolved.ok ? resolved.value.providerModel : alias;
      const provider =
        (resolved.ok ? providers?.get(resolved.value.providerName) : undefined) ?? defaultProvider;

      // 1) Circuit breaker gate (keyed by alias — the routing unit).
      const gate = breaker.canAttempt(alias);
      if (!gate.allow) {
        circuitSkipped = true;
        attempts.push(skipRow(alias, gate.reason ?? "circuit_open", elapsed()));
        continue;
      }

      // 2) Capability filter (only when we have catalog data for the alias).
      const caps = catalog.get(alias)?.capabilities;
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
          capabilityPruned = true;
          attempts.push(skipRow(alias, verdict.skipReason ?? "capability", elapsed()));
          continue;
        }
      }
      // Past the gates → this candidate is attempted against the upstream. A
      // failure from here on is a PROVIDER fault, not a capability gap.
      attemptedAny = true;

      // 3) Invoke the provider (stream or non-stream). We send the RESOLVED
      //    provider model (not the originally-requested alias) — the gateway
      //    picked this model, so the upstream must be told which one to run.
      try {
        if (req.stream) {
          const stream = await peekStream(provider, req, signal, providerModel, alias, log);
          breaker.recordSuccess(alias);
          // Streamed usage is not known at peek time → cost null (not measured).
          attempts.push(okRow(alias, elapsed(), null));
          return {
            attempts,
            final: { status: "ok", alias, providerModel },
            body: null,
            stream,
          };
        }
        const bodyReq = stripInternal(req, providerModel);
        const body = await provider.chatCompletion(bodyReq, { signal });
        breaker.recordSuccess(alias);
        attempts.push(okRow(alias, elapsed(), costOf(alias, body)));
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
          breaker.recordAbort(alias);
          attempts.push({
            alias,
            skipped: false,
            skip_reason: "aborted",
            status: "error",
            error_class: "client_abort",
            latency_ms: elapsed(),
            cost_usd: null,
            error_detail: null,
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
        // `:free` candidate 429 — ported llm-router semantics (principle 5):
        // skip to the next candidate, do NOT record a breaker failure (free-tier
        // throttling is not a provider-health signal). Distinct log field from
        // execution-fallback: skip_reason 'free_429', error_class 'rate_limited'.
        if (isFreeAlias(alias) && upstreamStatusOf(err) === 429) {
          attempts.push({
            alias,
            skipped: true,
            skip_reason: "free_429",
            status: "error",
            error_class: "rate_limited",
            latency_ms: elapsed(),
            cost_usd: null,
            error_detail: errorDetailOf(err),
          });
          continue;
        }

        // Genuine pre-first-chunk failure: record on the breaker, try next.
        breaker.recordFailure(alias);
        attempts.push({
          alias,
          skipped: false,
          skip_reason: null,
          status: "error",
          error_class: errorClassOf(err),
          latency_ms: elapsed(),
          cost_usd: null,
          error_detail: errorDetailOf(err),
        });
      }
    }

    // Chain exhausted (or empty). Pick the structured terminal error (docs/07):
    //   • empty chain                     → lane_unavailable (503)
    //   • NO candidate was ever attempted AND ≥1 was capability-pruned AND none
    //     was merely circuit-open         → capability_unsatisfiable (422): the
    //     request's hard constraints (json/vision/tools/context) could not be met
    //     by any known-incompatible candidate. A circuit-open skip is transient
    //     (retryable), so its presence keeps us on all_providers_failed.
    //   • otherwise                       → all_providers_failed (502): at least
    //     one candidate was attempted and failed, or skips were transient.
    let errorClass: "lane_unavailable" | "capability_unsatisfiable" | "all_providers_failed";
    let message: string;
    if (plan.candidate_chain.length === 0) {
      errorClass = "lane_unavailable";
      message = "lane has no candidates";
    } else if (!attemptedAny && capabilityPruned && !circuitSkipped) {
      errorClass = "capability_unsatisfiable";
      message = "no candidate satisfies the request's capability constraints";
    } else {
      errorClass = "all_providers_failed";
      message = "all providers in the candidate chain failed";
    }
    return {
      attempts,
      final: {
        status: "error",
        error: makeHelmError({ error_class: errorClass, message, trace_id: req.request_id }),
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
  alias: string,
  log?: (level: string, msg: string, fields: Record<string, unknown>) => void,
): Promise<AsyncIterable<string>> {
  const iterable = provider.chatCompletionStream(stripInternal(req, providerModel), { signal });
  const iterator = iterable[Symbol.asyncIterator]();
  const first = await iterator.next(); // may throw (pre-first-chunk failure)

  return (async function* relay(): AsyncGenerator<string> {
    if (!first.done && first.value !== undefined) yield first.value;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value !== undefined) yield next.value;
      }
    } catch (err) {
      // Truncated stream: the attempt was already recorded ok (success fires on
      // the first chunk — breaker semantics unchanged). Emit a structured log so
      // the truncation is observable despite the clean telemetry row. Safe fields
      // only — alias + error_class, NEVER key/payload/raw error (principle 7).
      log?.("warn", "stream.truncated", { alias, error_class: errorClassOf(err) });
      throw err;
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
  // Streamed usage (cost #6): OpenAI-compatible upstreams only emit a trailing
  // `usage` chunk when asked. Opt in so the gateway can price streamed calls
  // (the route parses that chunk to backfill completion cost). Harmless to the
  // client — it is the standard final usage frame.
  if (req.stream) body.stream_options = { include_usage: true };
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
    error_detail: null,
  };
}

function okRow(alias: string, latencyMs: number, costUsd: number | null): RouteProviderAttempt {
  return {
    alias,
    skipped: false,
    skip_reason: null,
    status: "ok",
    error_class: null,
    latency_ms: latencyMs,
    cost_usd: costUsd,
    error_detail: null,
  };
}
