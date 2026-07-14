// Codex weekly-limit auto-reset: the money-path predicates, kept pure + isolated
// so the (network-bound) wiring in server.ts can be unit-tested at the gate.
//
// Auto-reset consumes a SCARCE rate-limit reset credit (only a few per account),
// so the trigger must be conservative: only the account-wide WEEKLY window counts.
// Its primary/secondary position varies by plan, so duration is authoritative; the
// 5h window self-recovers and must never burn a credit —
// and at most ONE consume per account per hour (cooldown), so a burst of concurrent
// saturated replies can't drain the grant.

import { selectCodexAccountWeeklyQuotaWindows } from "@helm/shared";

// At least one hour between reset-credit consumes for the same shared ChatGPT
// account. The runtime also persists this guard so a container restart cannot
// rapidly drain the scarce reset-credit grant.
export const AUTO_RESET_COOLDOWN_MS = 60 * 60 * 1000;

// Manual and automatic reset-credit consumes are only allowed once the Codex weekly
// window is genuinely close to exhausted. The 5h window recovers on its own and
// must never justify spending a weekly reset credit.
export const CODEX_RESET_MIN_WEEKLY_USED_PERCENT = 90;

type CodexRateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

export type CodexResetCreditOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface ResetCreditReservationLifecycle {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function runResetCreditAttempt<
  TResult extends { outcome: CodexResetCreditOutcome },
>(input: {
  reservation: ResetCreditReservationLifecycle;
  consume(): Promise<TResult>;
  onConsumed?(result: TResult): void | Promise<void>;
}): Promise<{ result: TResult; consumed: boolean }> {
  let result: TResult;
  try {
    result = await input.consume();
  } catch (error) {
    await input.reservation.rollback();
    throw error;
  }

  const consumed = result.outcome === "reset" || result.outcome === "alreadyRedeemed";
  if (!consumed) {
    await input.reservation.rollback();
    return { result, consumed: false };
  }

  await input.reservation.commit();
  await input.onConsumed?.(result);
  return { result, consumed: true };
}

export function codexWeeklyUsedPercent(
  windows: ReadonlyArray<{
    key: string;
    limitId?: string;
    usedPercent: number;
    windowMinutes?: number | null;
  }>,
): number | null {
  const weekly = selectCodexAccountWeeklyQuotaWindows(windows)
    .map((w) => w.usedPercent)
    .filter((pct) => Number.isFinite(pct));
  return weekly.length === 0 ? null : Math.max(...weekly);
}

export function canConsumeResetCredit(
  windows: ReadonlyArray<{
    key: string;
    limitId?: string;
    usedPercent: number;
    windowMinutes?: number | null;
  }>,
  rateLimitReachedType?: CodexRateLimitReachedType | null,
): boolean {
  if (
    rateLimitReachedType !== undefined &&
    rateLimitReachedType !== null &&
    rateLimitReachedType !== "rate_limit_reached"
  ) {
    return false;
  }
  return (codexWeeklyUsedPercent(windows) ?? -1) >= CODEX_RESET_MIN_WEEKLY_USED_PERCENT;
}

// True when the account-wide WEEKLY window is fully used. The reported duration
// distinguishes it from the self-recovering 5h window across plan shapes.
export function weeklySaturated(
  windows: ReadonlyArray<{
    key: string;
    limitId?: string;
    usedPercent: number;
    windowMinutes?: number | null;
  }>,
): boolean {
  return (codexWeeklyUsedPercent(windows) ?? -1) >= 100;
}

// True when enough time has passed since the last auto-reset for this account
// (or it has never been auto-reset). `last` is the epoch-ms of the previous consume.
export function cooldownPassed(last: number | undefined, nowMs: number): boolean {
  return last === undefined || nowMs - last >= AUTO_RESET_COOLDOWN_MS;
}
