import type { EvalConfig, EvalOutput } from "@helm/shared";
import { parseEvalOutput } from "./contract.js";

// eval.client — the Layer-2 runner that ACTUALLY calls the internal small model
// to judge a request's lane. It composes: buildPrompt → non-streaming,
// temperature:0, max_tokens-capped invokeModel (supplied by provider.registry —
// the internal small-model alias, NOT one of the three public lanes) →
// parseEvalOutput (eval.contract). Two timeouts, with DISTINCT roles:
//   • config.timeout_ms = the PER-CANDIDATE deadline. It is NOT a local race here —
//     it is forwarded to invokeModel, which hands it to the executor as the loopback's
//     per-attempt budget. A slow head model (e.g. codex gpt-5.4-mini, p50≈5s) then
//     TIMES OUT and FALLS BACK to the next candidate inside the loopback (breaker
//     fault + advance), instead of aborting the whole eval as a client_abort;
//   • config.outer_timeout_ms = the TOTAL consumer guard. A `Promise.race` that, on
//     expiry, aborts the loopback so a chain that can't decide within the total budget
//     never hangs the main request path (event-loop stalls, an invokeModel that
//     ignores its AbortSignal, etc) — it fails open to balanced.
// Helm's improvements over the llm-router probe land here: a max_tokens cap (cost
// bound), the outer guard is REALLY wired (not dead config), the per-candidate timeout
// drives real execution fallback (not a single abort), and the output is decisive
// (parsed → decision), not advisory.
//
// `runEval` NEVER throws (CLAUDE.md principle 3). Every failure path — timeout,
// provider error, circuit-open, dirty output — collapses to
// `{ decided:false, reason }`; translating that into the balanced lane is
// eval.cascade's job (principle 5: classification fallback ≠ execution fallback;
// this layer never references `lane`). Circuit-open and AbortError are fail-open
// but NOT counted as provider faults (abort is not a fault — execution-layer
// semantics, see implementation-notes.md). Logs carry ONLY model / latency_ms /
// decided / reason — never the prompt, user messages, or raw model text
// (principle 7).

/** Marker error: the internal small-model provider's breaker is OPEN / HALF_OPEN
 *  rejecting. Thrown by `invokeModel`; mapped to a `circuit_open` fail-open
 *  reason WITHOUT recording an extra provider fault. */
export class CircuitOpenError extends Error {
  override readonly name = "CircuitOpenError";
}

/** Non-streaming request sent to the internal small model. */
export interface EvalModelRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: 0;
  stream: false;
  max_tokens: number;
  /** Provider-specific body passthrough from `config.extra_body`, merged verbatim
   *  onto the wire request by the invoker (e.g. `{ thinking: { type: disabled } }`).
   *  Present only when configured; never set by runEval otherwise. */
  extra_body?: Record<string, unknown>;
}

/** Raw, unparsed completion text from the small model, plus its self-cost when
 *  the provider surfaced usage/pricing. `cost_usd` is the Layer-2 eval self-cost
 *  (kept SEPARATE from completion cost downstream; docs/07). null/undefined when
 *  the upstream did not report a cost. */
export interface EvalModelResponse {
  text: string;
  cost_usd?: number | null;
}

/** Reason an eval call did not yield a decision — all fail-open to balanced
 *  upstream. `not_json` / `schema_invalid` are passed through from eval.contract. */
export type EvalFailReason =
  | "timeout"
  | "provider_error"
  | "circuit_open"
  | "not_json"
  | "schema_invalid";

export type EvalDecision =
  | { decided: true; output: EvalOutput; latency_ms: number; cost_usd: number | null }
  | { decided: false; reason: EvalFailReason; latency_ms: number };

/** Structured telemetry event — safe fields ONLY (principle 7). Never extend
 *  this with prompt / message / raw-output content. */
export interface EvalLogEvent {
  model: string;
  latency_ms: number;
  decided: boolean;
  reason: EvalFailReason | null;
}

export interface EvalClientDeps<TInput> {
  config: EvalConfig;
  /** Internal small-model call (provider.registry); non-streaming. Must honor the
   *  AbortSignal so the outer-budget timeout reclaims the upstream connection.
   *  `attemptTimeoutMs` is the PER-CANDIDATE deadline (config.timeout_ms): the loopback
   *  forwards it to the executor so a slow head model FALLS BACK to the next candidate
   *  instead of failing the whole eval (issue: codex gpt-5.4-mini p50≈5s on the eval
   *  hot path). The executor records a breaker fault + advances on each per-candidate
   *  timeout; the eval still fails open only if the TOTAL outer budget is exceeded. */
  invokeModel: (
    req: EvalModelRequest,
    signal: AbortSignal,
    attemptTimeoutMs: number,
  ) => Promise<EvalModelResponse>;
  /** Pure prompt builder; runEval never inspects TInput itself. */
  buildPrompt: (input: TInput) => EvalModelRequest["messages"];
  /** Injected clock for deterministic latency / timeout assertions. */
  now: () => number;
  /** Structured log sink; receives only safe fields. */
  log: (e: EvalLogEvent) => void;
}

// Sentinel resolved by the timeout races; distinct object so it can never collide
// with a legitimate model response.
const TIMEOUT = Symbol("eval_timeout");

function timeoutAfter(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(TIMEOUT), ms);
  });
}

/**
 * Run a Layer-2 eval. Returns a decision or a fail-open signal; NEVER throws.
 */
export async function runEval<TInput>(
  input: TInput,
  deps: EvalClientDeps<TInput>,
): Promise<EvalDecision> {
  const { config, invokeModel, buildPrompt, now, log } = deps;
  const start = now();
  const controller = new AbortController();

  const finish = (decision: EvalDecision): EvalDecision => {
    log({
      model: config.model,
      latency_ms: decision.latency_ms,
      decided: decision.decided,
      reason: decision.decided ? null : decision.reason,
    });
    return decision;
  };
  const elapsed = (): number => Math.max(0, now() - start);

  const request: EvalModelRequest = {
    model: config.model,
    messages: buildPrompt(input),
    // Re-assert determinism + non-streaming + cost cap explicitly on every call,
    // even though config already locks them, to defend against upstream defaults.
    temperature: 0,
    stream: false,
    max_tokens: config.max_tokens,
    // Forward provider-specific passthrough ONLY when configured, so the request
    // shape is unchanged for deployments that do not set it.
    ...(config.extra_body ? { extra_body: config.extra_body } : {}),
  };

  let raced: EvalModelResponse | typeof TIMEOUT;
  try {
    // The loopback call races the TOTAL outer budget. config.timeout_ms is NOT an
    // inner race here — it is forwarded to invokeModel as the PER-CANDIDATE deadline
    // the executor enforces, so a slow head model (e.g. codex gpt-5.4-mini) falls back
    // to the next candidate inside the loopback instead of aborting the whole eval.
    // outer_timeout_ms is the final consumer guard: if the chain can't decide within
    // the total budget we abort and fail open (balanced), never hanging the hot path.
    raced = await Promise.race([
      invokeModel(request, controller.signal, config.timeout_ms),
      timeoutAfter(config.outer_timeout_ms),
    ]);
  } catch (err) {
    // The upstream call rejected. Abort (defensive) and classify the failure.
    controller.abort();
    if (err instanceof CircuitOpenError) {
      return finish({ decided: false, reason: "circuit_open", latency_ms: elapsed() });
    }
    // AbortError and any other provider error are fail-open; abort is not a
    // counted fault (handled at the execution layer, not here).
    return finish({ decided: false, reason: "provider_error", latency_ms: elapsed() });
  }

  if (raced === TIMEOUT) {
    // Either timeout won — abort the upstream request to reclaim the connection.
    controller.abort();
    return finish({ decided: false, reason: "timeout", latency_ms: elapsed() });
  }

  const parsed = parseEvalOutput(raced.text);
  if (!parsed.ok) {
    return finish({ decided: false, reason: parsed.reason, latency_ms: elapsed() });
  }
  return finish({
    decided: true,
    output: parsed.value,
    latency_ms: elapsed(),
    // Layer-2 self-cost from the model response when the provider reported it;
    // null otherwise (unknown, not a measured 0). Kept separate from completion.
    cost_usd: typeof raced.cost_usd === "number" ? raced.cost_usd : null,
  });
}
