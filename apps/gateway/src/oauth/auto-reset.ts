// Codex weekly-limit auto-reset: the money-path predicates, kept pure + isolated
// so the (network-bound) wiring in server.ts can be unit-tested at the gate.
//
// Auto-reset consumes a SCARCE rate-limit reset credit (only a few per account),
// so the trigger must be conservative: only the WEEKLY window (Codex `secondary`)
// counts — the 5h window (`primary`) self-recovers and must never burn a credit —
// and at most ONE consume per account per hour (cooldown), so a burst of concurrent
// saturated replies can't drain the grant.

// At least one hour between reset-credit consumes for the same shared ChatGPT
// account. The runtime also persists this guard so a container restart cannot
// rapidly drain the scarce reset-credit grant.
export const AUTO_RESET_COOLDOWN_MS = 60 * 60 * 1000;

// Manual and automatic reset-credit consumes are only allowed once the Codex weekly
// window is genuinely close to exhausted. The 5h window recovers on its own and
// must never justify spending a weekly reset credit.
export const CODEX_RESET_MIN_WEEKLY_USED_PERCENT = 90;

export function codexWeeklyUsedPercent(
  windows: ReadonlyArray<{ key: string; usedPercent: number }>,
): number | null {
  const weekly = windows
    .filter((w) => w.key === "secondary")
    .map((w) => w.usedPercent)
    .filter((pct) => Number.isFinite(pct));
  return weekly.length === 0 ? null : Math.max(...weekly);
}

export function canConsumeResetCredit(
  windows: ReadonlyArray<{ key: string; usedPercent: number }>,
): boolean {
  return (codexWeeklyUsedPercent(windows) ?? -1) >= CODEX_RESET_MIN_WEEKLY_USED_PERCENT;
}

// True when the WEEKLY window is fully used. Codex keys the 7d window "secondary";
// the 5h window ("primary") is deliberately ignored (it recovers on its own).
export function weeklySaturated(
  windows: ReadonlyArray<{ key: string; usedPercent: number }>,
): boolean {
  return (codexWeeklyUsedPercent(windows) ?? -1) >= 100;
}

// True when enough time has passed since the last auto-reset for this account
// (or it has never been auto-reset). `last` is the epoch-ms of the previous consume.
export function cooldownPassed(last: number | undefined, nowMs: number): boolean {
  return last === undefined || nowMs - last >= AUTO_RESET_COOLDOWN_MS;
}
