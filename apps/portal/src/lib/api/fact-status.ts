import type { MemoryStatus } from "./memory-types";

export type FactStatusFilter = MemoryStatus | "superseded" | "all";

// Does a fact belong in the given status filter? "active"/"superseded" are both
// stored as status:"active" and split by the superseded flag; "archived"/"pruned"
// match on status alone; "all" matches everything. Guarding the archived/pruned
// branch matters — an unguarded `status === filter` also fires for filter:"active"
// and leaks superseded facts into the Active view.
export function factMatchesStatus(
  fact: { status: MemoryStatus; superseded: boolean },
  filter: FactStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "active") return fact.status === "active" && !fact.superseded;
  if (filter === "superseded") return fact.status === "active" && fact.superseded;
  return fact.status === filter; // archived | pruned
}
