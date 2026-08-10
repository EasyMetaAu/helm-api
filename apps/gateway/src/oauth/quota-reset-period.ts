import type { OAuthQuotaStore, OAuthResetPeriodStore } from "@helm/core";
import { detectQuotaResetPeriods, windowMinutesForKey } from "@helm/core";
import { type OAuthQuotaWindow, selectCodexAccountWeeklyQuotaWindows } from "@helm/shared";

export async function recordObservedQuotaResetPeriods(input: {
  quotaStore: OAuthQuotaStore;
  periodStore?: OAuthResetPeriodStore;
  providerId: string;
  account: string;
  windows: OAuthQuotaWindow[];
  observedAtMs: number;
}): Promise<void> {
  if (!input.periodStore) return;
  const previous = await input.quotaStore.get(input.providerId, input.account).catch(() => null);
  if (!previous || previous.capturedAt > input.observedAtMs) return;
  const periods = detectQuotaResetPeriods({
    providerId: input.providerId,
    account: input.account,
    previous: previous.windows,
    next: input.windows,
    observedAtMs: input.observedAtMs,
  });
  await Promise.all(periods.map((period) => input.periodStore?.record(period).catch(() => {})));
}

export async function recordQuotaResetCreditPeriods(input: {
  periodStore?: OAuthResetPeriodStore;
  providerId: "openai-codex";
  account: string;
  windows: OAuthQuotaWindow[];
  occurredAtMs: number;
}): Promise<void> {
  if (!input.periodStore) return;
  const windows = selectCodexAccountWeeklyQuotaWindows(input.windows);
  await Promise.all(
    windows.map(async (window) => {
      if (window.resetsAtMs === null) return;
      const minutes = windowMinutesForKey(window.key, window.windowMinutes);
      if (minutes === null) return;
      const inferredStart = window.resetsAtMs - minutes * 60_000;
      const latestResetAt =
        typeof input.periodStore?.latestResetAt === "function"
          ? await input.periodStore
              .latestResetAt(input.providerId, input.account, input.occurredAtMs, window.key)
              .catch(() => null)
          : null;
      const periodStartMs = Math.max(inferredStart, latestResetAt ?? Number.NEGATIVE_INFINITY);
      if (periodStartMs >= input.occurredAtMs) return;
      await input.periodStore
        ?.record({
          providerId: input.providerId,
          account: input.account,
          windowKey: window.key,
          periodStartMs,
          periodEndMs: input.occurredAtMs,
          detectedAtMs: input.occurredAtMs,
        })
        .catch(() => {});
    }),
  );
}
