import type {
  CircuitBreaker,
  ExecuteOutcome,
  ExecutionPlan,
  ProviderClient,
  ProviderRegistry,
  RouteProviderAttempt,
} from "@helm/core";
import { checkCapability, resolveCostUsd, UpstreamError } from "@helm/core";
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
// upstreams in order. Unknown aliases still fall back to `defaultProvider` for
// Phase-0 passthrough; a resolved provider with no registered client is skipped
// fail-closed, never silently served with another provider's credential.
//
// Streaming (principle 8): for stream:true the provider stream is forwarded
// UNBUFFERED. We peek the FIRST chunk to decide success vs. pre-first-chunk
// failure (matching the breaker contract), then hand back a generator that
// re-emits that first chunk followed by the rest — byte-for-byte, in order.

export interface ExecuteAdapterDeps {
  /** Default/fallback provider client: used only for unknown aliases
   *  (Phase-0 single-provider passthrough). */
  defaultProvider: ProviderClient;
  /** Per-provider clients keyed by provider NAME (registry providerName). When a
   *  candidate resolves to one of these, its client is used -> chains cross
   *  providers. Missing clients fail closed; defaultProvider is only for unknown
   *  aliases in Phase-0 passthrough. */
  providers?: Map<string, ProviderClient>;
  registry: ProviderRegistry;
  /** Known OAuth subscription provider IDs (ROUTABLE_OAUTH keys). An alias whose
   *  `<prefix>/` is one of these is a SUBSCRIPTION alias and is gated authoritatively
   *  by `oauthAliases` below — it must NEVER fall through to the registry or
   *  defaultProvider (that would cross subscription/credential boundaries). Absent →
   *  the gate is off (back-compat for tests that don't wire OAuth). */
  knownOAuthPrefixes?: ReadonlySet<string>;
  /** LIVE set of currently-exposed (curated) OAuth `<provider>/<model>` aliases,
   *  re-read per request so a Manage-dialog curation removal / disconnect takes
   *  effect immediately: a subscription alias NOT in this set fails CLOSED
   *  (provider_unavailable), never routes stale. Rebuilt alongside the pool. */
  oauthAliases?: () => ReadonlySet<string>;
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
  if (err instanceof UpstreamError) {
    // OAuth (issue #38, D5): a persistent upstream 401 — the client already
    // refreshed + retried once — is an authentication failure, not a generic
    // upstream error. Classify it as `auth_error` (an existing ErrorClass) so the
    // decision record / client error reflects the real cause. This is a pure
    // relabel at the existing classification chokepoint; breaker counting and
    // chain advancement are unchanged (D6 — no new executor branch).
    if (err.upstreamStatus === 401) return "auth_error";
    return err.errorClass;
  }
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
  const knownOAuthPrefixes = deps.knownOAuthPrefixes;
  const oauthAliases = deps.oauthAliases;

  // Cost of one served attempt = provider usage × catalog pricing (docs/07).
  // Keyed by the candidate ALIAS — the catalog/pricing modelKey is the routing
  // alias (e.g. `openai-crs/gpt-5.4-mini`), NOT the bare upstream model id we send
  // on the wire (`gpt-5.4-mini`). See the resolve block below.
  // Prefer an upstream-BILLED cost the response carried (real money charged —
  // `usage.cost_usd` / OpenRouter `usage.cost` / top-level `cost_usd`); otherwise
  // estimate from token usage × catalog pricing (resolveCostUsd, the single
  // override-or-preset rule). Missing BOTH (no billed cost AND no catalog entry /
  // half-filled pricing row) → null ("not measured", distinct from a measured 0)
  // and a logged miss, NEVER a crash (principle 3). Streaming attempts have no
  // usage at peek time → null here, backfilled by the route from the usage chunk.
  const costOf = (alias: string, body: unknown): number | null => {
    const pricing = catalog.get(alias)?.pricing;
    const cost = resolveCostUsd(pricing, body);
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
      // the provider client (so the fallback chain can cross providers). If that
      // resolved provider has no client, skip fail-closed; falling back to the
      // default would cross credential/subscription boundaries.
      let providerModel: string;
      let provider: ProviderClient | undefined;
      const slash = alias.indexOf("/");
      const prefix = slash > 0 ? alias.slice(0, slash) : "";
      if (prefix && (knownOAuthPrefixes?.has(prefix) ?? false)) {
        // SUBSCRIPTION alias (issue #38). The live curation set + the pool are the
        // SINGLE source of truth — re-read per request so a Manage-dialog removal,
        // parking, or disconnect takes effect immediately. A subscription alias that
        // is not CURRENTLY exposed, or whose pool is gone, fails CLOSED here; it must
        // NEVER fall through to the registry's startup snapshot or to defaultProvider
        // (that would route a removed/disconnected subscription model, or cross a
        // subscription/credential boundary). The pool client forwards the bare model.
        const exposed = oauthAliases?.().has(alias) ?? false;
        const pool = providers?.get(prefix);
        if (!exposed || !pool) {
          attempts.push(skipRow(alias, "provider_unavailable", elapsed()));
          continue;
        }
        provider = pool;
        providerModel = alias.slice(slash + 1);
      } else {
        // Non-subscription alias. Resolve alias -> { provider name, upstream model }.
        // Two DISTINCT ids come out and must not be conflated (fix-upstream-model-id
        // 2026-05-31): `alias` is the ROUTING key (catalog/pricing/breaker/decision
        // id); `providerModel` is the wire `model`. An unknown alias is a config gap:
        // keep the alias as the upstream model id too and use the default provider
        // (fail-open Phase-0 passthrough — never substitute a different model). A
        // resolved alias selects BOTH the upstream model id AND the provider client
        // (so the fallback chain can cross providers); a resolved provider with no
        // client skips fail-closed rather than crossing credentials.
        const resolved = registry.resolve(alias);
        if (resolved.ok) {
          providerModel = resolved.value.providerModel;
          provider = providers?.get(resolved.value.providerName);
        } else if (prefix && providers?.has(prefix)) {
          // Structural fallback for a NON-subscription `provider/model` alias the
          // registry never enumerated but whose provider client IS registered by name
          // (the pool/client forwards the bare model id). Subscription prefixes never
          // reach here — they took the gated branch above.
          providerModel = alias.slice(slash + 1);
          provider = providers.get(prefix);
        } else {
          providerModel = alias;
          provider = defaultProvider;
        }
      }
      if (!provider) {
        attempts.push(skipRow(alias, "provider_unavailable", elapsed()));
        continue;
      }

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
