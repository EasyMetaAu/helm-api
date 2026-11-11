import {
  aggregateByCalendar,
  computeUsagePeriods,
  filterRetiredOpenAICodexLimits,
  windowMinutesForKey,
} from "@helm/core";
import { isCodexQuotaWindowPlaceholder, type OAuthResetPeriod } from "@helm/shared";
import type { AdminApiDeps, OAuthAdminStatusResponse } from "./deps.js";

const ESTIMATE_SUPERSEDE_MS = 3 * 60 * 60_000;

function resetEventBoundaries(
  rows: OAuthResetPeriod[],
  nextResetAtMs: number | null,
  nowMs: number,
  windowMs: number | null,
): Array<{ startMs: number; endMs: number; approximate: boolean; usedPercent?: number | null }> {
  // The old writer stored [oldReset, projectedNextReset); the current writer stores a
  // complete closed period ending at the observed reset. Keep complete periods intact;
  // only the legacy shape needs reconstructing from proven reset events.
  const rawPoints = rows
    .flatMap((row) => {
      const atMs =
        row.detectedAtMs >= row.periodEndMs
          ? row.periodEndMs
          : row.periodStartMs <= row.detectedAtMs
            ? row.periodStartMs
            : null;
      return atMs === null
        ? []
        : [{ atMs, approximate: row.approximate ?? false, usedPercent: row.usedPercent ?? null }];
    })
    .filter((point) => point.atMs <= nowMs);
  const exactPoints = rawPoints.filter((point) => !point.approximate);
  const points = [
    ...new Map(
      rawPoints
        .filter(
          (point) =>
            !point.approximate ||
            !exactPoints.some(
              (exact) => Math.abs(exact.atMs - point.atMs) <= ESTIMATE_SUPERSEDE_MS,
            ),
        )
        .sort((a, b) => Number(b.approximate) - Number(a.approximate))
        .map((point) => [point.atMs, point] as const),
    ).values(),
  ].sort((a, b) => a.atMs - b.atMs);
  const plausible = (startMs: number, endMs: number) =>
    windowMs !== null && startMs < endMs && endMs - startMs <= windowMs * 1.5;
  const boundaries = points.slice(1).flatMap((end, index) => {
    const start = points[index] ?? end;
    return plausible(start.atMs, end.atMs)
      ? [
          {
            startMs: start.atMs,
            endMs: end.atMs,
            approximate: start.approximate || end.approximate,
            usedPercent: end.usedPercent,
          },
        ]
      : [];
  });
  for (const row of rows) {
    if (
      row.usedPercent == null ||
      row.detectedAtMs < row.periodEndMs ||
      row.periodEndMs > nowMs ||
      !plausible(row.periodStartMs, row.periodEndMs)
    ) {
      continue;
    }
    const closed = {
      startMs: row.periodStartMs,
      endMs: row.periodEndMs,
      approximate: row.approximate ?? false,
      usedPercent: row.usedPercent,
    };
    const index = boundaries.findIndex((boundary) => boundary.endMs === row.periodEndMs);
    if (index < 0) boundaries.push(closed);
    else boundaries[index] = closed;
  }
  const latest = points.at(-1);
  if (
    latest !== undefined &&
    nextResetAtMs !== null &&
    nextResetAtMs > nowMs &&
    plausible(latest.atMs, nextResetAtMs)
  ) {
    boundaries.push({
      startMs: latest.atMs,
      endMs: nextResetAtMs,
      approximate: latest.approximate,
      usedPercent: null,
    });
  }
  return boundaries;
}

export type OAuthUsageReaderDeps = Pick<
  AdminApiDeps,
  "oauth" | "oauthUsage" | "oauthQuota" | "oauthResetPeriod"
> & { settings: Pick<AdminApiDeps["settings"], "get"> };

// Admin retains its existing fail-open behavior. The machine export must report
// failed reads explicitly, so a remote screen never mistakes an outage for zero.
export function createOAuthUsageReader(deps: OAuthUsageReaderDeps, failOpen = true) {
  const seam = () => deps.oauth;
  const acctKey = (providerId: string, account: string) => `${providerId}\u0000${account}`;
  const boundKeys = (status: OAuthAdminStatusResponse): Set<string> =>
    new Set(
      status.providers.flatMap((provider) =>
        provider.accounts.map((account) => acctKey(provider.id, account.account)),
      ),
    );

  // Local-only usage aggregation. Binding metadata comes from cached token/settings
  // state; this function never refreshes a token or calls a provider.
  const readUsage = async (rawTz: unknown, status: OAuthAdminStatusResponse | null) => {
    const store = deps.oauthUsage;
    if (!store) return [];
    const now = Date.now();
    const parsedTz = Number(rawTz);
    const tzOffsetMinutes =
      Number.isInteger(parsedTz) && parsedTz >= -720 && parsedTz <= 840 ? parsedTz : 0;
    const offsetMs = tzOffsetMinutes * 60_000;
    const start = now + offsetMs - ((now + offsetMs) % 86_400_000) - offsetMs;
    const end = start + 86_400_000;
    const bound = status ? boundKeys(status) : null;
    try {
      const rows = await store.queryRange(start, end);
      return rows
        .filter((r) => !bound || bound.has(acctKey(r.providerId, r.account)))
        .map((r) => {
          const minutes = Math.max(1, (now - r.firstSeenMs) / 60_000);
          return {
            providerId: r.providerId,
            account: r.account,
            requests: r.requests,
            tokens: r.tokens,
            costUsd: r.costUsd,
            rpm: Math.round((r.requests / minutes) * 100) / 100,
          };
        });
    } catch (error) {
      if (!failOpen) throw error;
      return [];
    }
  };

  // Per-reset-period usage for ONE account (the account-detail page). Reconstructs
  // token/cost totals sliced by quota reset window from the raw hour buckets +
  // current quota snapshot — see computeUsagePeriods. Purpose: spot a provider
  // silently shrinking an allowance (per-period token totals trending down). Token
  // totals are exact; historical boundaries are approximate (rolled back a fixed
  // window length — flagged per period). Cache-only + FAIL-OPEN: any gap → empty.
  const EMPTY_PERIODS = { current: [], periods: [], daily: [], weekly: [] };
  const readPeriods = async (
    providerId: string,
    account: string,
    rawTz: unknown,
  ): Promise<{ current: unknown[]; periods: unknown[]; daily: unknown[]; weekly: unknown[] }> => {
    const usage = deps.oauthUsage;
    const quotaStore = deps.oauthQuota;
    if (!usage || !quotaStore) return EMPTY_PERIODS;
    const parsedTz = Number(rawTz);
    const tzOffsetMinutes =
      Number.isInteger(parsedTz) && parsedTz >= -720 && parsedTz <= 840 ? parsedTz : 0;
    try {
      const snapshot = await quotaStore.get(providerId, account);
      if (!snapshot) return EMPTY_PERIODS;
      const now = Date.now();
      // Fetch every retained hour bucket (oauth_usage retention floor → now).
      const retentionDays = deps.settings.get().oauth_usage_retention_days;
      const retentionFloorMs = now - retentionDays * 86_400_000;
      const buckets = await usage.queryBuckets(retentionFloorMs, now, providerId, account);
      // `current`: the in-progress RESET period per window — exact (real resetsAtMs), the
      // "this window has burned X so far" summary. limit 1: we only want the current one.
      const earliestBucketMs = buckets[0]?.bucketMs ?? now; // ascending → [0] is earliest
      const dataStartMs = Math.max(retentionFloorMs, earliestBucketMs);
      const recordedBoundaries = Object.fromEntries(
        await Promise.all(
          snapshot.windows.map(async (window) => {
            const rows =
              (await deps.oauthResetPeriod
                ?.queryPeriods(providerId, account, window.key, 53)
                .catch((error: unknown) => {
                  if (!failOpen) throw error;
                  return [];
                })) ?? [];
            const minutes = windowMinutesForKey(window.key, window.windowMinutes);
            return [
              window.key,
              resetEventBoundaries(
                rows,
                window.resetsAtMs,
                now,
                minutes === null ? null : minutes * 60_000,
              ),
            ] as const;
          }),
        ),
      );
      const { current, periods } = computeUsagePeriods({
        windows: snapshot.windows,
        buckets,
        nowMs: now,
        dataStartMs,
        limit: 52,
        recordedBoundaries,
      });
      // History: NATURAL calendar day/week in the admin's local tz — exact, honest, and
      // free of the reset-period drift/reset-credit distortion. A period is `partial`
      // (undercounts) on EITHER edge: it starts before retained data (left), or it ends
      // in the future — the in-progress day/week (right). Marking the open period partial
      // is essential: a mid-week bar is only ~3/7 of a full week and would otherwise read
      // as a false allowance drop (grok review CR1).
      const daily = aggregateByCalendar(buckets, tzOffsetMinutes, "day");
      const weekly = aggregateByCalendar(buckets, tzOffsetMinutes, "week");
      const markPartial = (rows: typeof daily) =>
        rows.map((r) =>
          r.periodStartMs < dataStartMs || r.periodEndMs > now ? { ...r, partial: true } : r,
        );
      return { current, periods, daily: markPartial(daily), weekly: markPartial(weekly) };
    } catch (error) {
      if (!failOpen) throw error;
      return EMPTY_PERIODS;
    }
  };

  // Read the durable quota rows plus any richer in-process Codex metadata. This is
  // intentionally side-effect free: no upstream PULL, orphan pruning, or cooldown
  // mutation happens on a page read.
  const readCachedQuota = async (
    status: OAuthAdminStatusResponse | null,
  ): Promise<Array<Record<string, unknown>>> => {
    const store = deps.oauthQuota;
    if (!store) return [];
    const bound = status ? boundKeys(status) : null;
    const identities = new Map<string, Record<string, unknown>>();
    for (const provider of status?.providers ?? []) {
      for (const account of provider.accounts) {
        const identity = {
          ...(account.email === undefined ? {} : { email: account.email }),
          ...(account.chatgptPlanType === undefined
            ? {}
            : { chatgptPlanType: account.chatgptPlanType }),
          ...(account.chatgptAccountId === undefined
            ? {}
            : { chatgptAccountId: account.chatgptAccountId }),
          ...(account.isFedramp === undefined ? {} : { isFedramp: account.isFedramp }),
        };
        if (Object.keys(identity).length > 0) {
          identities.set(acctKey(provider.id, account.account), identity);
        }
      }
    }
    try {
      const result: Array<Record<string, unknown>> = [];
      for (const row of await store.getAll()) {
        const key = acctKey(row.providerId, row.account);
        if (bound && !bound.has(key)) continue;
        // In-process cache (fresh, richest) wins; when it is cold — e.g. right after
        // a restart — fall back to the metadata PERSISTED on the row so the card
        // renders plan/credits/reset-details instead of blanking until a refresh.
        const liveMetadata =
          row.providerId === "openai-codex"
            ? await seam()?.getCachedCodexQuota?.({ account: row.account })
            : null;
        const metadata =
          liveMetadata !== null && liveMetadata !== undefined
            ? liveMetadata
            : row.providerId === "openai-codex"
              ? {
                  resetCredits: row.resetCredits ?? null,
                  resetCreditDetails: row.resetCreditDetails ?? null,
                  credits: row.credits ?? null,
                  individualLimit: row.individualLimit ?? null,
                  additionalLimits: row.additionalLimits ?? [],
                  planType: row.planType ?? null,
                  rateLimitReachedType: row.rateLimitReachedType ?? null,
                }
              : null;
        const identity = identities.get(key);
        result.push({
          ...row,
          ...(row.providerId === "openai-codex"
            ? {
                windows: filterRetiredOpenAICodexLimits(row.windows).filter(
                  (window) => !isCodexQuotaWindowPlaceholder(window, row.capturedAt),
                ),
              }
            : {}),
          ...(identity === undefined ? {} : { identity }),
          ...(metadata === null || metadata === undefined
            ? {}
            : {
                resetCredits: metadata.resetCredits,
                resetCreditDetails: metadata.resetCreditDetails,
                credits: metadata.credits,
                individualLimit: metadata.individualLimit,
                additionalLimits: filterRetiredOpenAICodexLimits(metadata.additionalLimits),
                planType: metadata.planType,
                rateLimitReachedType: metadata.rateLimitReachedType,
              }),
        });
      }
      return result;
    } catch (error) {
      if (!failOpen) throw error;
      return [];
    }
  };

  return { readUsage, readPeriods, readCachedQuota };
}
