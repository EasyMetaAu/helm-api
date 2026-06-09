import { z } from "zod";
import type { IRRequest } from "./ir.js";

// —— Inter-translation hardening (P8). When an IR carries a knob a target backend
// cannot honor, the rule (CLAUDE.md principle 3 + the "never silently drop" P8
// goal) is: degrade DETERMINISTICALLY and RECORD a structured warning — never let
// data vanish without a trace, and never 5xx on a non-fatal mismatch.
//
// Two non-mappable shapes are covered:
//   • REJECT-CLEAN cap: `n>1` on a backend that emits a single candidate is capped
//     to 1 with an `n_capped` warning (degrade, don't drop, don't error).
//   • DATA-LOSS guard: a param with no native home on the target (logprobs ->
//     Anthropic, modalities -> a text-only backend, …) emits a `data_loss` warning
//     so the loss is observable.
//
// Warnings live on the IR's `provider_raw.warnings` (the IR-internal passthrough
// bag), NOT on any native wire object — transformers strip provider_raw before
// serialization, so the no-leak matrix invariant holds while DecisionRecord /
// telemetry can still read the warnings off the IR. All helpers are PURE: they
// return a new IR and never mutate the input.

export const ProtocolWarningCodeSchema = z.enum(["n_capped", "data_loss"]);
export type ProtocolWarningCode = z.infer<typeof ProtocolWarningCodeSchema>;

export const ProtocolWarningSchema = z
  .object({
    code: ProtocolWarningCodeSchema,
    param: z.string(), // the IR field that could not be honored (e.g. "n", "logprobs")
    target: z.string(), // the target protocol/backend that cannot honor it
    message: z.string(),
  })
  .strict();
export type ProtocolWarning = z.infer<typeof ProtocolWarningSchema>;

/** Read the structured warnings recorded on an IR request's provider_raw bag. */
export function readWarnings(ir: IRRequest): ProtocolWarning[] {
  const raw = ir.provider_raw?.warnings;
  if (!Array.isArray(raw)) return [];
  // Be permissive on read: keep only the entries that parse to the strict shape.
  const out: ProtocolWarning[] = [];
  for (const entry of raw) {
    const parsed = ProtocolWarningSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Append a structured warning to provider_raw.warnings, returning a NEW IR.
 * Pure: the input IR and its provider_raw bag are never mutated. Other
 * provider_raw keys (stop_reason / usage / …) are preserved verbatim.
 */
export function pushWarning(ir: IRRequest, warning: ProtocolWarning): IRRequest {
  const validated = ProtocolWarningSchema.parse(warning);
  const existing = readWarnings(ir);
  return {
    ...ir,
    provider_raw: {
      ...(ir.provider_raw ?? {}),
      warnings: [...existing, validated],
    },
  };
}

/**
 * REJECT-CLEAN cap for `n`: a backend that cannot emit multiple candidates caps
 * `n>1` to 1 and records an `n_capped` warning. `n` of 1 / undefined is a no-op
 * (the SAME reference is returned so callers can cheaply detect "nothing changed").
 */
export function capNToOne(ir: IRRequest, target: string): { ir: IRRequest; capped: boolean } {
  if (ir.n === undefined || ir.n <= 1) return { ir, capped: false };
  const requested = ir.n;
  const withWarning = pushWarning(ir, {
    code: "n_capped",
    param: "n",
    target,
    message: `Target "${target}" returns a single candidate; n=${requested} was capped to 1.`,
  });
  return { ir: { ...withWarning, n: 1 }, capped: true };
}

/**
 * DATA-LOSS guard: record a `data_loss` warning when `param` is present on the IR
 * but the target has no native surface for it. A missing value — or an empty
 * `modalities`/`stop` array — is treated as absent (nothing to lose) and returns
 * the input unchanged. Pure.
 */
export function warnUnsupported(
  ir: IRRequest,
  param: keyof IRRequest,
  target: string,
  reason: string,
): IRRequest {
  const value = ir[param];
  const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  if (!present) return ir;
  return pushWarning(ir, {
    code: "data_loss",
    param: String(param),
    target,
    message: `Target "${target}" has no surface for "${String(param)}": ${reason}`,
  });
}

// —— Per-target capability map. The SINGLE source of truth for which non-mappable
// knobs each backend triggers a guard for. Anthropic Messages has no multi-candidate
// (`n`), no token `logprobs`, and is text-out only (`modalities`); Gemini honors
// candidateCount/responseLogprobs/responseModalities natively, so it needs no guard.
// OpenAI Chat is the IR's own shape (everything maps), so it is a no-op too.
interface TargetGuardSpec {
  /** Cap n>1 to 1 because the backend emits a single candidate. */
  readonly capN: boolean;
  /** IR params with no native surface on this target -> data_loss warnings. */
  readonly unsupported: ReadonlyArray<{ param: keyof IRRequest; reason: string }>;
}

const TARGET_GUARDS: Record<string, TargetGuardSpec> = {
  anthropic: {
    capN: true,
    unsupported: [
      { param: "logprobs", reason: "Anthropic Messages does not expose token logprobs." },
      { param: "top_logprobs", reason: "Anthropic Messages does not expose token logprobs." },
      { param: "modalities", reason: "Anthropic Messages is text-out only." },
      // Sampling knobs Anthropic Messages has no native surface for (order 8): they
      // were dropped silently before — now the loss is recorded, never invisible.
      {
        param: "frequency_penalty",
        reason: "Anthropic Messages has no frequency_penalty control.",
      },
      { param: "presence_penalty", reason: "Anthropic Messages has no presence_penalty control." },
      { param: "seed", reason: "Anthropic Messages does not accept a sampling seed." },
      {
        param: "cache_control",
        reason: "Anthropic caches via per-block cache_control, not a request-level knob.",
      },
    ],
  },
  // openai / gemini intentionally absent: every guarded knob has a native home.
};

/**
 * Apply the full guard set for a target to an IR request, returning a NEW IR whose
 * non-mappable knobs are degraded (n capped) and whose losses are recorded on
 * provider_raw.warnings. Unknown / fully-capable targets are a pure no-op (same
 * reference). Transformers call this at the top of transformRequestIn so the native
 * output is correct AND the IR carries an observable record of every degradation.
 */
export function guardRequestFor(target: string, ir: IRRequest): IRRequest {
  const spec = TARGET_GUARDS[target];
  if (spec === undefined) return ir;
  let next = ir;
  if (spec.capN) next = capNToOne(next, target).ir;
  for (const { param, reason } of spec.unsupported) {
    next = warnUnsupported(next, param, target, reason);
  }
  return next;
}
