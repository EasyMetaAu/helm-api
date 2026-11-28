// Claude subscription "limit resets" come in kinds that restore different things:
// a whole-week reset clears the 7-day limit itself, while a Fable reset only gives
// back the Fable allowance (and what Fable used of the week) without resetting the
// week. The grant's `clears` list is the authoritative signal for which one it is.
import type { AnthropicResetGrant, AnthropicResetStatus } from '@helm/shared';

export type ResetKind = 'week' | 'fable' | 'other';

export function resetKind(grant: Pick<AnthropicResetGrant, 'clears'>): ResetKind {
  if (grant.clears.includes('seven_day')) return 'week';
  if (grant.clears.includes('seven_day_overage_included')) return 'fable';
  return 'other';
}

export interface ResetKindSummary {
  kind: ResetKind;
  /** Resets still available across every live grant of this kind. */
  left: number;
  /** Earliest expiry among those grants. */
  endsAt: string;
}

const KIND_ORDER: ResetKind[] = ['week', 'fable', 'other'];

export function summarizeResetGrants(
  status: AnthropicResetStatus,
  nowMs: number,
): { byKind: ResetKindSummary[]; next: ResetKindSummary | null } {
  const live = status.grants.filter(
    (g) => g.resets_left > 0 && !g.paused && Date.parse(g.ends_at) > nowMs,
  );
  const byKind: ResetKindSummary[] = [];
  for (const kind of KIND_ORDER) {
    const grants = live.filter((g) => resetKind(g) === kind);
    if (grants.length === 0) continue;
    byKind.push({
      kind,
      left: grants.reduce((sum, g) => sum + g.resets_left, 0),
      endsAt: grants.map((g) => g.ends_at).sort((a, b) => Date.parse(a) - Date.parse(b))[0],
    });
  }
  // Anthropic decides which grant is spent next; the action uses that grant's kind.
  const nextGrant = live.find((g) => g.id === status.next_grant_id) ?? null;
  const next = nextGrant ? (byKind.find((s) => s.kind === resetKind(nextGrant)) ?? null) : null;
  return { byKind, next };
}
