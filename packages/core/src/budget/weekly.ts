import type { WeeklyBudgetStatus } from "@helm/shared";
import type { BudgetStore } from "../store/ports.js";
import type { BudgetCaps } from "./types.js";

export const WEEK_MS = 7 * 86_400_000;

// UTC instants keep a fixed seven-day cadence, independent of the server timezone.
export function weeklyPeriodStart(nowMs: number, anchorMs: number): number {
  return anchorMs + Math.floor((nowMs - anchorMs) / WEEK_MS) * WEEK_MS;
}

export async function readWeeklyBudget(
  store: Pick<BudgetStore, "peek">,
  keyId: string,
  caps: BudgetCaps,
  nowMs: number,
): Promise<WeeklyBudgetStatus | null> {
  if (caps.weeklyAnchor == null) return null;
  const anchorMs = Date.parse(caps.weeklyAnchor);
  const start = weeklyPeriodStart(nowMs, anchorMs);
  const read = async (dim: "req" | "tok" | "usd", limit: number | null) => {
    if (limit === null) return null;
    const { remaining } = await store.peek(keyId, dim, limit, WEEK_MS, nowMs, anchorMs);
    return { limit, used: limit - remaining, remaining };
  };
  return {
    period_start: new Date(start).toISOString(),
    resets_at: new Date(start + WEEK_MS).toISOString(),
    requests: await read("req", caps.requests),
    tokens: await read("tok", caps.tokens),
    spend_usd: await read("usd", caps.spendUsd),
  };
}
