import type { AnthropicResetGrant, AnthropicResetStatus } from '@helm/shared';
import { describe, expect, it } from 'vitest';
import { resetKind, summarizeResetGrants } from './anthropic-reset-kinds';

const grant = (over: Partial<AnthropicResetGrant>): AnthropicResetGrant => ({
  id: 'g',
  label: null,
  resets_total: 1,
  resets_left: 1,
  ends_at: '2027-03-09T07:59:00+00:00',
  clears: ['seven_day_overage_included'],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  blocking: [],
  ...over,
});

// Live shape seen on production (2026-11-28): one spent full reset, one spent and
// two available Fable-only resets.
const status: AnthropicResetStatus = {
  eligible: true,
  at_limit: false,
  exhausted: [],
  next_grant_id: 'fable-12mo',
  cooldown_until: null,
  pending: false,
  grants: [
    grant({
      id: 'full-2611',
      clears: ['seven_day', 'seven_day_overage_included'],
      resets_left: 0,
      usable_now: false,
    }),
    grant({ id: 'fable-launch', resets_left: 0, usable_now: false }),
    grant({ id: 'fable-12mo' }),
    grant({ id: 'fable-6mo' }),
  ],
};

describe('Claude reset grant kinds', () => {
  it('tells a whole-week reset from a Fable-only reset by what it clears', () => {
    expect(resetKind(grant({ clears: ['seven_day', 'seven_day_overage_included'] }))).toBe('week');
    expect(resetKind(grant({ clears: ['seven_day_overage_included'] }))).toBe('fable');
    expect(resetKind(grant({ clears: ['five_hour'] }))).toBe('other');
  });

  it('adds up remaining resets per kind instead of showing only the next grant', () => {
    const summary = summarizeResetGrants(status, Date.parse('2026-11-28T00:00:00Z'));
    expect(summary.byKind).toEqual([
      { kind: 'fable', left: 2, endsAt: '2027-03-09T07:59:00+00:00' },
    ]);
    expect(summary.next?.kind).toBe('fable');
    expect(summary.next?.left).toBe(2);
  });

  it('ignores expired grants', () => {
    const summary = summarizeResetGrants(status, Date.parse('2027-04-01T00:00:00Z'));
    expect(summary.byKind).toEqual([]);
    expect(summary.next).toBeNull();
  });
});
