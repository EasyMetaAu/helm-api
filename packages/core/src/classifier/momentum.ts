import type { ClassifierRulesConfig } from "@helm/shared";
import type { Complexity } from "./tiers.js";

// Session momentum — a single short follow-up ("yes", "go on", "再写一段") would,
// if classified in isolation, get scored `simple` and drag a complex/reasoning
// conversation off-course. Momentum maintains a short, TTL'd classification
// history per `x-session-key` and, when THIS message is short, blends the
// historical rawScore back in. The shorter the message the higher the history
// weight; past an upper char cap momentum switches fully off.
//
// This is a STATEFUL but pure-at-the-boundary layer (CLAUDE.md principle 4): the
// clock (`now`) and the store are INJECTED, so TTL and write timestamps are
// deterministic and unit-testable, and core stays DB-agnostic (principle 1).
// Failure modes are fail-open (principle 3): no session key / disabled / no fresh
// history all return the input rawScore verbatim, never throwing.
//
// Cache-key contract (see docs/03-classification.md §Layer-2 cache comparison):
// the momentum key is `x-session-key` — a SESSION-dimension key WITH a TTL —
// which is a different cache from the eval's content-hash key (a STATELESS,
// content-dimension key). The two must not be conflated.

/**
 * A single historical classification. Holds ONLY complexity/rawScore/at — never
 * plaintext message content (CLAUDE.md principle 7: no private payload in state).
 * `at` is an epoch-ms timestamp (from the injected clock at record time).
 */
export interface MomentumEntry {
  complexity: Complexity;
  rawScore: number;
  /** epoch ms */
  at: number;
}

/**
 * Storage port — injected so core never binds to a concrete DB. The default
 * implementation is an in-memory Map (see momentum-store.ts); a Store adapter
 * may be substituted. `get` returns the recent history for a session key.
 */
export interface MomentumStore {
  get(sessionKey: string): MomentumEntry[];
  push(sessionKey: string, entry: MomentumEntry): void;
}

export interface MomentumDeps {
  store: MomentumStore;
  /** Injected clock (epoch ms) — drives TTL and record timestamps. */
  now: () => number;
  cfg: ClassifierRulesConfig;
}

export interface MomentumResult {
  /** rawScore after blending in history (== input when momentum is off). */
  adjustedRawScore: number;
  /** True iff momentum changed the score (enabled, keyed, has fresh history, w>0). */
  momentumApplied: boolean;
  /** The history weight actually used ∈ [0, max_history_weight]. */
  historyWeight: number;
}

// Linear weight curve by message length:
//   chars <= short_message_max_chars        → max_history_weight (full pull-back)
//   chars >= disable_above_chars            → 0 (momentum off)
//   in between                              → linear interpolation
// Returns 0 for a degenerate config where the cutoffs cross (fail-open).
function weightForLength(chars: number, cfg: ClassifierRulesConfig["momentum"]): number {
  const { short_message_max_chars: lo, disable_above_chars: hi, max_history_weight: wMax } = cfg;
  if (chars >= hi) return 0;
  if (chars <= lo) return wMax;
  if (hi <= lo) return 0; // degenerate config — disable rather than divide by ≤0
  const frac = (hi - chars) / (hi - lo); // 1 at lo, 0 at hi
  return wMax * frac;
}

const off = (rawScore: number): MomentumResult => ({
  adjustedRawScore: rawScore,
  momentumApplied: false,
  historyWeight: 0,
});

/**
 * Blend historical rawScore into THIS message's rawScore when the message is
 * short enough. Momentum only adjusts the rawScore — the final tier is re-mapped
 * by `tiers`, so momentum never directly changes the tier (no double judgement).
 *
 * `sessionKey === null` (no `x-session-key`), `cfg.momentum.enabled === false`,
 * or no fresh (non-expired) history all bypass momentum and return rawScore as-is.
 */
export function applyMomentum(
  args: { sessionKey: string | null; rawScore: number; messageChars: number },
  deps: MomentumDeps,
): MomentumResult {
  const { sessionKey, rawScore, messageChars } = args;
  const mcfg = deps.cfg.momentum;

  if (!mcfg.enabled) return off(rawScore);
  if (sessionKey === null) return off(rawScore); // do not even read the store

  const historyWeight = weightForLength(messageChars, mcfg);
  if (historyWeight <= 0) return off(rawScore);

  // Most-recent-first, TTL-filtered, capped at history_size.
  const now = deps.now();
  const cutoff = now - mcfg.ttl_sec * 1000;
  const fresh = deps.store
    .get(sessionKey)
    .filter((e) => e.at >= cutoff)
    .slice(-mcfg.history_size);

  if (fresh.length === 0) return off(rawScore); // no fresh history → no momentum

  const avg = fresh.reduce((sum, e) => sum + e.rawScore, 0) / fresh.length;
  const adjustedRawScore = (1 - historyWeight) * rawScore + historyWeight * avg;

  return { adjustedRawScore, momentumApplied: true, historyWeight };
}

/**
 * Write the final classification of THIS turn back into history (engine calls it
 * after the tier is decided). The entry is restamped with the injected clock so
 * `at` reflects the deterministic "now". Only complexity/rawScore/at are stored —
 * no plaintext message content (principle 7). No session key → silent no-op.
 */
export function recordMomentum(
  sessionKey: string | null,
  entry: MomentumEntry,
  deps: MomentumDeps,
): void {
  if (sessionKey === null) return;
  deps.store.push(sessionKey, {
    complexity: entry.complexity,
    rawScore: entry.rawScore,
    at: deps.now(),
  });
}
