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
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n === 0) return "$0.00";

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
  if (s.includes(".")) {
    s = s.replace(/(\.\d{2}\d*?)0+$/, "$1");
  }
  return `$${s}`;
}
