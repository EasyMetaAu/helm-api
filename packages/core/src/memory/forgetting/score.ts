// The forgetting score (docs/12 "The forgetting score") — the pure, deterministic
// core of the whole forgetting loop. It fuses three primitives mined from the
// reference projects: Ebbinghaus exponential recency decay (Generative Agents /
// Graphiti), importance as a multiplicative decay BRAKE with a floor (Generative
// Agents), and access reinforcement via a log1p frequency term (Cognee /
// MemoryScope).
//
//   score(now) = recency(now) × (importance_weight + access_bonus)
//
//   recency(now)       = 0.5 ^ (age_seconds / half_life_seconds)
//   age_seconds        = max(0, now − last_referenced_at)
//   last_referenced_at = coalesce(referenced_at, fallback_ts)   // NEVER null
//   importance_weight  = clamp(importance, importance_floor, importance_ceil)
//   access_bonus       = access_weight × log1p(reference_count)
//
// The access bonus lives INSIDE the recency product (Codex review fix): an earlier
// draft ADDED it after the product, which made it a permanent score floor — one
// injection (reference_count = 1) yielded a bonus above the default archive
// threshold, so a once-used row could NEVER be forgotten no matter how old it got.
// Multiplying instead means reinforcement works exactly like spaced repetition:
// touching a memory resets `referenced_at` (recency back to ~1, full bonus), but a
// memory that STOPS being used decays toward 0 — bonus and all. Nothing is
// un-forgettable; reinforcement only delays forgetting.
//
// CLAUDE.md principles this module is load-bearing for:
//  - "确定性优先" (determinism-first): no LLM, no network, no clock read. `now` is
//    ALWAYS supplied by the caller, so the function is a pure mapping of its inputs
//    and is exhaustively unit-testable — identical in TS and in the SQL the decay
//    sweep will mirror (docs/12: "One pure function, identical in SQL and TypeScript").
//  - The curve params (`half_life_s`, floors/ceil, `access_weight`) are CONFIG, not
//    columns (docs/12 config surface), so retuning the curve is a config edit, not a
//    migration, and the score stays reproducible from
//    `(coalesce(referenced_at, fallback_ts), reference_count, importance)` + config.
//
// Zero dependencies on store / config-loader / framework — this is a leaf module
// that later phases (inject trim in P4, decay sweep in P5) import. The Zod config
// schema (P1) is the single source of truth for the param TYPES; this module accepts
// the snake_case param subset structurally so it never has to import the schema and
// stays a pure leaf. Keys are snake_case to mirror the YAML / `z.infer` shape exactly.

// The curve params the score reads — the `memory.forgetting.score` block, snake_case
// to match config/memory.yaml and the P1 `ScoreSchema` (z.infer). Declared here as a
// structural subset so this leaf module needs no import from @helm/shared; P1's
// `z.infer<typeof ScoreSchema>` is assignable to this. importance_floor ≤
// importance_ceil is enforced by the config schema (fail-closed at startup), so the
// clamp here trusts that invariant.
export interface ScoreConfig {
  readonly half_life_s: number;
  readonly importance_floor: number;
  readonly importance_ceil: number;
  readonly access_weight: number;
}

// The per-row inputs the score reads off a tiered memory row. `referencedAt` starts
// null (a memory that has never been re-injected) and is only written by the
// reinforcement hook (P3); the score therefore coalesces it to a per-tier
// `fallbackTs` — observed_at for observations, updated_at for reflections, created_at
// for facts (docs/12 fallback table) — so a fresh or legacy row can NEVER produce a
// null / NaN score or be wrongly archived. The caller (store/sweep) is responsible
// for picking the correct per-tier `fallbackTs`; the math here is tier-agnostic.
export interface ScoreInput {
  readonly referencedAt: Date | null;
  readonly fallbackTs: Date;
  readonly referenceCount: number;
  readonly importance: number;
}

// `last_referenced_at` is NEVER null: coalesce(referenced_at, fallback_ts). This is a
// `??` in TS, a `coalesce(...)` in SQL — the same rule on both sides. A null
// `referencedAt` means "never reinforced, age from when the row was created", which is
// exactly correct (docs/12), and the migration does not need to backfill the column.
export function effectiveReferencedAt(referencedAt: Date | null, fallbackTs: Date): Date {
  return referencedAt ?? fallbackTs;
}

// Ebbinghaus recency, re-parameterised from `R = e^(−t/S)` to a half-life so that
// `t½ = half_life_seconds` and no `e` / `ln` is needed (trivially correct in both
// SQLite `pow(0.5, age/hl)` and TS `Math.pow`). Age is clamped to ≥ 0 so a
// `referenced_at` slightly in the future (clock skew between writer and scorer) can
// never push recency ABOVE 1.0 — a fresh memory is the ceiling. age == 0 → exactly 1;
// age == half_life → exactly 0.5.
export function recency(ageSeconds: number, halfLifeSeconds: number): number {
  const age = ageSeconds > 0 ? ageSeconds : 0;
  return 0.5 ** (age / halfLifeSeconds);
}

// clamp(importance, floor, ceil). importance_floor > 0 is the DECAY BRAKE: a vital
// memory's effective weight never reaches 0, so recency × importance can never
// collapse to exactly 0 and the memory is forgotten LAST (docs/12 rationale).
function clamp(value: number, floor: number, ceil: number): number {
  if (value < floor) return floor;
  if (value > ceil) return ceil;
  return value;
}

// The full forgetting score for one tiered row at instant `now` (caller-supplied —
// the function never reads the real clock). Recency is the MULTIPLICATIVE core over
// EVERYTHING — importance AND the access bonus (Codex review fix: an additive bonus
// was a permanent floor that made once-used rows un-forgettable). The bonus still
// uses `log1p` (diminishing returns: the 50th recall does not dominate the 5th), and
// reinforcement still pays off — bumping `referenced_at` resets recency to ~1, so a
// recently-used row scores `importance + bonus` at full strength — but a row that
// stops being used decays toward 0, bonus included. Nothing is un-forgettable.
export function forgettingScore(input: ScoreInput, config: ScoreConfig, now: Date): number {
  const lastReferencedAt = effectiveReferencedAt(input.referencedAt, input.fallbackTs);
  // Milliseconds → seconds. `now − last_referenced_at`; the clamp lives in recency().
  const ageSeconds = (now.getTime() - lastReferencedAt.getTime()) / 1000;
  const recencyTerm = recency(ageSeconds, config.half_life_s);
  const importanceWeight = clamp(input.importance, config.importance_floor, config.importance_ceil);
  const accessBonus = config.access_weight * Math.log1p(input.referenceCount);
  return recencyTerm * (importanceWeight + accessBonus);
}
