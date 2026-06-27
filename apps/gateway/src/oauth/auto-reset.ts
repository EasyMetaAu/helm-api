// Codex weekly-limit auto-reset: the money-path predicates, kept pure + isolated
// so the (network-bound) wiring in server.ts can be unit-tested at the gate.
//
// Auto-reset consumes a SCARCE rate-limit reset credit (only a few per account),
// so the trigger must be conservative: only the WEEKLY window (Codex `secondary`)
// counts — the 5h window (`primary`) self-recovers and must never burn a credit —
// and at most ONE consume per account per hour (cooldown), so a burst of concurrent
// saturated replies can't drain the grant.

// At least one hour between reset-credit consumes for the same account. A freshly
// reset weekly window cannot re-saturate within an hour, so this also makes the
// in-memory cooldown safe across a gateway restart (no second spend is physically
// possible before it would expire anyway).
export const AUTO_RESET_COOLDOWN_MS = 60 * 60 * 1000;

// True when the WEEKLY window is fully used. Codex keys the 7d window "secondary";
// the 5h window ("primary") is deliberately ignored (it recovers on its own).
export function weeklySaturated(
  windows: ReadonlyArray<{ key: string; usedPercent: number }>,
): boolean {
  return windows.some((w) => w.key === "secondary" && w.usedPercent >= 100);
}

// True when enough time has passed since the last auto-reset for this account
// (or it has never been auto-reset). `last` is the epoch-ms of the previous consume.
export function cooldownPassed(last: number | undefined, nowMs: number): boolean {
  return last === undefined || nowMs - last >= AUTO_RESET_COOLDOWN_MS;
}
