// Shared display formatters for the admin UI. Read-only presentation — never
// re-computes backend figures, only renders them.

// Format a USD cost for the requests table / cost breakdown.
//
// WHY adaptive precision: relay models can be extraordinarily cheap (a DeepSeek
// completion costs ~$0.0000244). A fixed `toFixed(4)` renders every sub-$0.0001
// cost as "$0.0000" — indistinguishable from free, which made operators think
// cost tracking was broken when it was merely invisible. We instead widen the
// decimal places for small magnitudes so any non-zero cost shows ≥2 significant
// figures, while normal/large costs stay at a clean 2–4 decimals.
//
// Sentinels:
//   • null / undefined / NaN → "—"  (NOT measured — distinct from a measured 0;
//     mirrors the backend's null-vs-0 cost invariant, docs/07).
//   • exactly 0              → "$0.00" (measured zero / free).
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '$0.00';

  const abs = Math.abs(n);
  let decimals: number;
  if (abs >= 1) {
    decimals = 2;
  } else {
    // Enough places to show ~3 significant figures: e.g. 0.0000244 → 7 places.
    // Math.floor(log10(abs)) is the exponent of the leading digit (-5 for 2.4e-5);
    // 2 places past it captures three significant figures. Clamp to [2, 10].
    decimals = Math.min(10, Math.max(2, 2 - Math.floor(Math.log10(abs))));
  }

  // Trim trailing zeros beyond the 2nd decimal so "$0.00000340" → "$0.0000034"
  // and "$12.50" stays "$12.50" (a minimum of 2 decimals is always kept).
  let s = n.toFixed(decimals);
  if (s.includes('.')) {
    s = s.replace(/(\.\d{2}\d*?)0+$/, '$1');
  }
  return `$${s}`;
}

// Compact token count for the dashboard stat cards + chart axes/tooltips. Token
// totals run large (millions), so a raw "1234567" is unreadable on a card; we
// abbreviate to ~3 significant figures with a K/M/B suffix (1.23M, 34.5K), the
// same convention the reference dashboard uses. The SINGLE source of truth for
// rendering a token COUNT — never re-summed here, only formatted.
//
// Sentinels mirror formatUsd: null/undefined/NaN → "—" (not measured); a measured
// 0 → "0" (distinct). Negative inputs are clamped to 0 (a count is never < 0).
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  // Pick the largest unit that leaves a value ≥ 1, then show ~3 sig-figs: one
  // decimal under 100 (12.3K), none at/above (345K). Trailing ".0" is trimmed.
  const units: Array<{ limit: number; suffix: string }> = [
    { limit: 1_000_000_000, suffix: 'B' },
    { limit: 1_000_000, suffix: 'M' },
    { limit: 1_000, suffix: 'K' },
  ];
  for (const { limit, suffix } of units) {
    if (v >= limit) {
      const scaled = v / limit;
      const s = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '');
      return `${s}${suffix}`;
    }
  }
  return String(Math.round(v));
}

// Generic compact count (requests, errors, rows…): the abbreviation rules are
// identical to token counts, so this is the same function under a name that
// doesn't lie about what it formats. Callers pick the alias that matches the
// quantity so a future divergence (e.g. tokens gaining a unit suffix) only has
// to touch one signature.
export const formatCount = formatTokens;

// Coarse, magnitude-aware breakdown of a duration (in ms) — the SINGLE source of
// truth for "anything past 24h rolls up to days". Returns just the numbers +
// which bucket they fall in; callers map the bucket to their own phrasing/i18n
// key ("in {d}d {h}h" for token expiry, "resets in {d}d {h}h" for quota windows)
// so the unit stays legible at every scale.
//
// WHY this exists: token-expiry used to format raw h+m, so a weekly Codex window
// rendered "238h 22m" instead of "9d 22h". The quota-reset countdown already
// coarsened correctly; this lifts that one rule out so every duration label
// agrees on it. Kept i18n-free and side-effect-free (no `Date.now()`) so it is
// trivially unit-testable.
//
// Buckets, by descending magnitude:
//   • ≥ 24h → "dh": days + leftover whole hours (sub-hour minutes are dropped)
//   • ≥  1h → "hm": hours + minutes
//   • <  1h → "m":  minutes only
// Negative spans (already elapsed) clamp to zero.
export type DurationParts =
  | { readonly unit: 'dh'; readonly d: number; readonly h: number }
  | { readonly unit: 'hm'; readonly h: number; readonly m: number }
  | { readonly unit: 'm'; readonly m: number };

export function durationParts(ms: number): DurationParts {
  const left = Math.max(0, ms);
  const d = Math.floor(left / 86_400_000);
  if (d > 0) {
    return { unit: 'dh', d, h: Math.floor((left % 86_400_000) / 3_600_000) };
  }
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return h > 0 ? { unit: 'hm', h, m } : { unit: 'm', m };
}

// Render a recorded ISO timestamp in the viewer's local timezone/locale. The
// gateway records times in UTC (ISO 8601, `…Z`); both the request list column
// and the detail header show them through this helper so the operator reads the
// time in their own timezone rather than raw UTC. Empty input → "" so each
// caller supplies its own placeholder ("—" on the list, "time not recorded" on
// the detail page); a non-empty but unparseable value passes through unchanged
// rather than rendering "Invalid Date".
export function formatTimestamp(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}
