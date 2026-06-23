// Reciprocal Rank Fusion (docs/14 / docs/12 P8 — hybrid fact retrieval).
//
// Fuses N ranked id lists (each already sorted best-first) into one ranking by
// summing 1/(k + rank) across the lists. Rank-based ⇒ SCALE-FREE: BM25 (unbounded,
// negative), cosine similarity (0..1), and the forgetting score (recency × importance
// + access) live on incompatible scales, so we fuse RANKS, never raw scores — no
// normalization, no tuned per-signal weights. `k = 60` is the TREC-standard constant
// (Cormack et al.); it is a CODE constant, NOT config — a per-deploy RRF k would be a
// lying knob (the field finds k ∈ [40,80] equivalent).
//
// Pure + deterministic: identical input ⇒ identical output. A score tie is broken by
// id ascending so the order is stable across runs and trivially unit-testable on a
// fixture. An id appearing in multiple lists accumulates all its contributions; an
// empty list contributes nothing.

export const RRF_K = 60;

export interface FusedRank {
  readonly id: string;
  readonly score: number;
}

export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyArray<string>>,
  k: number = RRF_K,
): FusedRank[] {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    let rank = 0;
    for (const id of list) {
      rank++; // 1-based rank within this list
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
