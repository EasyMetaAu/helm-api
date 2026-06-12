import { describe, expect, it } from 'vitest';
import { durationParts, formatTimestamp, formatTokens, formatUsd } from './format.js';

describe('formatTokens — compact token counts for the dashboard', () => {
  it('renders not-measured (null/undefined/NaN) as an em dash', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(Number.NaN)).toBe('—');
  });

  it('shows a measured zero as "0" (distinct from not-measured)', () => {
    expect(formatTokens(0)).toBe('0');
  });

  it('shows raw integers under 1000', () => {
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(42.6)).toBe('43');
  });

  it('abbreviates thousands/millions/billions to ~3 significant figures', () => {
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(1234)).toBe('1.2K');
    expect(formatTokens(34_500)).toBe('34.5K');
    expect(formatTokens(345_000)).toBe('345K');
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(2_000_000_000)).toBe('2B');
  });

  it('clamps a negative count to 0', () => {
    expect(formatTokens(-5)).toBe('0');
  });
});

describe('formatUsd — adaptive USD precision', () => {
  it('renders not-measured (null/undefined/NaN) as an em dash', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(Number.NaN)).toBe('—');
  });

  it('renders a measured zero as $0.00 (distinct from not-measured)', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('keeps 2 decimals for whole-dollar magnitudes', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(1)).toBe('$1.00');
    expect(formatUsd(329.4321)).toBe('$329.43');
  });

  it('shows tiny sub-cent costs at ~3 significant figures instead of $0.0000', () => {
    // The bug: these all rendered $0.0000 under toFixed(4).
    expect(formatUsd(0.00002436)).toBe('$0.0000244');
    expect(formatUsd(0.0000034)).toBe('$0.0000034');
    expect(formatUsd(0.0347)).toBe('$0.0347');
  });

  it('trims trailing zeros but always keeps at least 2 decimals', () => {
    expect(formatUsd(0.5)).toBe('$0.50');
    expect(formatUsd(0.87)).toBe('$0.87');
    expect(formatUsd(0.001)).toBe('$0.001');
  });

  it('never collapses a visible small non-zero cost to $0.00', () => {
    expect(formatUsd(0.0000244)).not.toBe('$0.00');
    expect(formatUsd(0.0000244)).not.toBe('$0.0000');
  });
});

const H = 3_600_000;
const M = 60_000;
const D = 86_400_000;

describe('durationParts — coarsen a span by magnitude (>24h rolls up to days)', () => {
  it('under an hour: minutes only', () => {
    expect(durationParts(10 * M)).toEqual({ unit: 'm', m: 10 });
    expect(durationParts(0)).toEqual({ unit: 'm', m: 0 });
    expect(durationParts(59 * M + 59_000)).toEqual({ unit: 'm', m: 59 });
  });

  it('one hour up to a day: hours + minutes', () => {
    expect(durationParts(H)).toEqual({ unit: 'hm', h: 1, m: 0 });
    expect(durationParts(6 * H + 21 * M)).toEqual({ unit: 'hm', h: 6, m: 21 });
    expect(durationParts(23 * H + 59 * M)).toEqual({ unit: 'hm', h: 23, m: 59 });
  });

  it('exactly 24h rolls up to days', () => {
    expect(durationParts(D)).toEqual({ unit: 'dh', d: 1, h: 0 });
  });

  it('the bug: 238h 22m must read as days, not raw hours', () => {
    // Screenshot regression: a Codex weekly window showed "238 小时 22 分钟后".
    expect(durationParts(238 * H + 22 * M)).toEqual({ unit: 'dh', d: 9, h: 22 });
  });

  it('drops sub-hour minutes once we are in the days bucket', () => {
    // A days-scale span only carries days + hours, never trailing minutes.
    expect(durationParts(4 * D + 14 * H + 37 * M)).toEqual({ unit: 'dh', d: 4, h: 14 });
  });

  it('clamps negative spans to zero (already elapsed)', () => {
    expect(durationParts(-5000)).toEqual({ unit: 'm', m: 0 });
  });
});

// formatTimestamp renders a recorded ISO timestamp in the viewer's *local*
// timezone/locale (the request list column and the detail header both use it).
// It is a pure passthrough to Date#toLocaleString, so the exact string is
// environment dependent — we assert behaviour, not a fixed locale rendering.
describe("formatTimestamp — render recorded UTC in the viewer's local zone", () => {
  it('formats a valid ISO timestamp into the browser-local string, not raw UTC', () => {
    const iso = '2026-06-07T02:27:19.748Z';
    expect(formatTimestamp(iso)).toBe(new Date(iso).toLocaleString());
    // The whole point of the fix: never surface the raw UTC ISO string.
    expect(formatTimestamp(iso)).not.toBe(iso);
  });

  it('returns empty string for empty input (caller supplies the placeholder)', () => {
    expect(formatTimestamp('')).toBe('');
  });

  it('passes a non-empty but unparseable value through unchanged', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});
