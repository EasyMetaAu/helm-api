import {
  aggregateByCalendar,
  computeUsagePeriods,
  filterRetiredOpenAICodexLimits,
  GROK_OAUTH_MEDIA_MODELS,
  windowMinutesForKey,
  windowsToActiveUsageRecovery,
  windowsToUsageLimit,
} from "@helm/core";
import {
  isCodexQuotaWindowPlaceholder,
  type OAuthQuotaWindow,
  type OAuthResetPeriod,
} from "@helm/shared";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../../app.js";
import { createOAuthAdminRefreshCoordinator } from "../../oauth/admin-refresh-coordinator.js";
import {
  CODEX_RESET_MIN_WEEKLY_USED_PERCENT,
  canConsumeResetCredit,
  codexWeeklyUsedPercent,
  runResetCreditAttempt,
  weeklySaturated,
} from "../../oauth/auto-reset.js";
import {
  isPermanentOAuthCredentialFailure,
  oauthCredentialFailureReason,
} from "../../oauth/credential-failure.js";
import { recordObservedQuotaResetPeriods } from "../../oauth/quota-reset-period.js";
import type {
  AccountProxyInput,
  AdminApiDeps,
  CodexQuotaResult,
  OAuthAdminAccess,
  OAuthAdminStatusResponse,
  OAuthSelectionStrategy,
} from "./deps.js";

// /admin/api/oauth/* — interactive OAuth subscription login from the admin UI
// (issue #38). Pure HTTP glue (Principle 1): every flow step delegates to the
// injected OAuthAdminAccess seam; this file owns NO crypto, NO store access, NO
// ephemeral session state. Sits behind the admin basicAuth like the rest of
// /admin/api/*. Returns 503 when OAuth wiring is absent (e.g. no HELM_OAUTH_ENC_KEY).
//
// Two flows:
//   - manual_paste (Anthropic): start -> open authorizeUrl -> paste redirect URL.
//   - device_code (Copilot): start -> show user code -> poll until done.

const DEFAULT_ACCOUNT = "default";
const ESTIMATE_SUPERSEDE_MS = 3 * 60 * 60_000;

function resetEventBoundaries(
  rows: OAuthResetPeriod[],
  nextResetAtMs: number | null,
  nowMs: number,
  windowMs: number | null,
): Array<{ startMs: number; endMs: number; approximate: boolean }> {
  // The old writer stored [oldReset, projectedNextReset); the current writer stores a
  // closed period ending at the observed reset. Reduce both shapes to proven events.
  const rawPoints = rows
    .flatMap((row) => {
      const atMs =
        row.detectedAtMs >= row.periodEndMs
          ? row.periodEndMs
          : row.periodStartMs <= row.detectedAtMs
            ? row.periodStartMs
            : null;
      return atMs === null ? [] : [{ atMs, approximate: row.approximate ?? false }];
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
    windowMs !== null && endMs - startMs <= windowMs * 1.5;
  const boundaries = points.slice(1).flatMap((end, index) => {
    const start = points[index] ?? end;
    return plausible(start.atMs, end.atMs)
      ? [
          {
            startMs: start.atMs,
            endMs: end.atMs,
            approximate: start.approximate || end.approximate,
          },
        ]
      : [];
  });
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
    });
  }
  return boundaries;
}

// Narrow an unknown thrown value to a safe, already-scrubbed message. The seam's
// errors are constructed without token material (TokenRefreshError / generic),
// so echoing the message is safe; anything else degrades to a generic string.
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "oauth request failed";
}

type DevicePollErrorCode =
  | "device_authorization_denied"
  | "device_code_expired"
  | "device_poll_failed";

function devicePollErrorCode(e: unknown): DevicePollErrorCode {
  const message = errMessage(e).toLowerCase();
  if (message.includes("denied")) return "device_authorization_denied";
  if (message.includes("expired") || message.includes("session not found")) {
    return "device_code_expired";
  }
  return "device_poll_failed";
}

// A client disconnect / modal close surfaces as an aborted signal or an AbortError.
// Treated as NOT a provider failure (Principle: client disconnect ≠ upstream fault),
// so the /test stream ends silently instead of emitting a spurious error event.
function isAbort(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
}

async function recordCredentialFailure(
  deps: AdminApiDeps,
  providerId: string,
  account: string,
  err: unknown,
): Promise<void> {
  if (!deps.onOAuthCredentialFailure || !isPermanentOAuthCredentialFailure(err)) return;
  await deps
    .onOAuthCredentialFailure(providerId, account, oauthCredentialFailureReason(err))
    .catch(() => {});
}

function testUsageTokens(ev: {
  type: string;
  promptTokens?: unknown;
  completionTokens?: unknown;
  totalTokens?: unknown;
}): number | null {
  if (ev.type !== "usage") return null;
  if (typeof ev.totalTokens === "number" && Number.isFinite(ev.totalTokens)) {
    return Math.max(0, Math.trunc(ev.totalTokens));
  }
  const prompt =
    typeof ev.promptTokens === "number" && Number.isFinite(ev.promptTokens) ? ev.promptTokens : 0;
  const completion =
    typeof ev.completionTokens === "number" && Number.isFinite(ev.completionTokens)
      ? ev.completionTokens
      : 0;
  return Math.max(0, Math.trunc(prompt + completion));
}

// A malformed proxy body — thrown by parseProxyInput, caught at the route to map to
// a 400. Distinct type so a genuine seam error isn't masked as a parse error.
class ProxyParseError extends Error {}

const SELECTION_STRATEGIES: ReadonlySet<string> = new Set([
  "balanced",
  "manual_priority",
  "low_risk",
  "use_expiring",
]);

function parseSelectionStrategy(raw: unknown): OAuthSelectionStrategy | null {
  return typeof raw === "string" && SELECTION_STRATEGIES.has(raw)
    ? (raw as OAuthSelectionStrategy)
    : null;
}

// Parse a request body's `proxy` field into the AccountProxyInput write shape (or
// null = no/clear proxy). Shared by the connect-start routes (proxy from step 1)
// and PUT /proxy (issue #38). Fail-closed: a malformed shape throws → 400, never a
// silent direct connection. Validation of host/port range happens in the seam.
function parseProxyInput(raw: unknown): AccountProxyInput | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new ProxyParseError("proxy must be an object or null");
  const p = raw as Record<string, unknown>;
  if (
    (p.type !== "http" && p.type !== "https" && p.type !== "socks5") ||
    typeof p.host !== "string" ||
    typeof p.port !== "number"
  ) {
    throw new ProxyParseError("proxy requires type (http|https|socks5), host, port");
  }
  return {
    type: p.type,
    host: p.host,
    port: p.port,
    ...(typeof p.username === "string" ? { username: p.username } : {}),
    ...(typeof p.password === "string" ? { password: p.password } : {}),
  };
}

export function registerOAuthRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // Resolve the seam per-request so the 503 guard is uniform.
  const seam = (): OAuthAdminAccess | undefined => deps.oauth;

  // Hot-reload the routable OAuth pool after a mutation, so proxy / priority /
  // schedulable / curation / connect / disconnect take effect on the NEXT request
  // without a restart. Awaited before the route returns. Returns whether the live
  // rebuild APPLIED: when it didn't (e.g. a transient refresh/discovery failure during
  // re-synthesis), the persist still SUCCEEDED, so the caller returns a 503
  // "saved but not applied" rather than a false 204 — the change takes effect on the
  // next successful mutation or a restart. No hook wired (unit tests) ⇒ applied.
  const afterMutation = async (): Promise<boolean> => {
    if (!deps.onOAuthMutation) return true;
    try {
      return (await deps.onOAuthMutation()).applied;
    } catch {
      return false;
    }
  };
  // Body for the 503 a mutating route returns when persist succeeded but the live
  // rebuild failed — honest "saved, not yet live" signal (Principle 3: fail visible).
  const notApplied = {
    error:
      "saved but could not be applied to the live pool; it will take effect on the next change or a restart",
    code: "not_applied",
  } as const;

  // A credential replacement may keep the same operator-facing account label but
  // represent a different upstream identity. Remove the old identity's durable
  // windows/cooldown before rebuilding the live pool, otherwise startup/rebuild
  // seeding can attach stale quota to the replacement credential.
  const clearDurableQuota = async (providerId: string, account: string): Promise<boolean> => {
    if (!deps.oauthQuota) return true;
    try {
      await deps.oauthQuota.delete(providerId, account);
      return true;
    } catch {
      return false;
    }
  };

  // GET /oauth -> provider catalog + which accounts are logged in (no secrets).
  app.get("/admin/api/oauth", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured (set HELM_OAUTH_ENC_KEY)" }, 503);
    return c.json(await s.listCachedStatus());
  });

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
    } catch {
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
                .catch(() => [])) ?? [];
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
    } catch {
      return EMPTY_PERIODS;
    }
  };

  // Explicit refresh job body. All upstream work lives here, behind the refresh
  // coordinator; cache-only GET routes never call it.
  const refreshQuota = async (): Promise<void> => {
    const store = deps.oauthQuota;
    if (!store) return;
    const s = seam();
    // listStatus (the bound OAuth tokens) is the source of truth for "which accounts
    // exist". We use it BOTH to refresh the Anthropic PULL and to drop ORPHANED
    // snapshots: a renamed / logged-out account otherwise leaves a stale row (e.g. a
    // Codex push captured under an old label) that would show as a phantom account.
    const acctKey = (providerId: string, account: string) => `${providerId}\u0000${account}`;
    let bound: Set<string> | null = null;
    const failures: string[] = [];
    const syncCooldownFromWindows = async (
      providerId: string,
      account: string,
      windows: Parameters<typeof windowsToActiveUsageRecovery>[0],
    ): Promise<void> => {
      if (!deps.applyUsageLimit) return;
      const nowMs = Date.now();
      const current = await store.get(providerId, account).catch(() => null);
      const currentUntil = current?.usageLimitedUntilMs ?? null;
      if (currentUntil === null || currentUntil <= nowMs) {
        const quotaUntil = windowsToUsageLimit(windows, nowMs);
        if (quotaUntil !== null) {
          await deps.applyUsageLimit(providerId, account, quotaUntil, "extend").catch(() => {});
        }
        return;
      }
      const quotaUntil = windowsToActiveUsageRecovery(windows, nowMs);
      if (quotaUntil === null) {
        await deps.applyUsageLimit(providerId, account, null, "replace").catch(() => {});
        return;
      }
      if (currentUntil === quotaUntil) return;
      await deps.applyUsageLimit(providerId, account, quotaUntil, "replace").catch(() => {});
    };
    const recordResetBoundaries = async (
      providerId: string,
      account: string,
      newWindows: OAuthQuotaWindow[],
    ): Promise<void> =>
      recordObservedQuotaResetPeriods({
        quotaStore: store,
        periodStore: deps.oauthResetPeriod,
        providerId,
        account,
        windows: newWindows,
        observedAtMs: Date.now(),
      });
    if (s) {
      try {
        const status = await s.listStatus({ forceRefresh: true, serial: true });
        bound = new Set(
          status.providers.flatMap((p) => p.accounts.map((a) => acctKey(p.id, a.account))),
        );
        // Refresh the usage-endpoint PULL for each connected account (cached in the
        // seam). Anthropic and Codex both expose one; the Codex `x-codex-*` header
        // PUSH still updates the same store on live traffic — the PULL covers
        // accounts that have served nothing yet (else they render "—" forever).
        // NB: this observability PULL refreshes the stored window snapshot (and, for
        // Codex, the live reset-credit count) and parks an otherwise active account
        // only when an account-wide window is truly saturated (100% with a future
        // reset). Near-full windows (98-99%) are used only after a real 429 has already
        // created a cooldown, where they refine the recovery time. That keeps healthy
        // near-full accounts schedulable while preventing the UI from saying "limited"
        // as the pool continues to route to the same exhausted account.
        const acctsOf = (id: string) => status.providers.find((x) => x.id === id)?.accounts ?? [];
        const tasks: Array<{ label: string; run: () => Promise<void> }> = [];
        // Anthropic: windows only.
        const fetchAnthropic = s.fetchAnthropicQuota;
        if (fetchAnthropic) {
          for (const a of acctsOf("anthropic")) {
            tasks.push({
              label: `anthropic/${a.account}`,
              run: async () => {
                const windows = await fetchAnthropic({ account: a.account, force: true });
                if (!windows || windows.length === 0) {
                  throw new Error("quota refresh returned no windows");
                }
                const capturedAt = Date.now();
                await recordResetBoundaries("anthropic", a.account, windows);
                await store.upsert({
                  providerId: "anthropic",
                  account: a.account,
                  windows,
                  capturedAt,
                  source: "anthropic",
                });
                deps.applyQuotaSnapshot?.("anthropic", a.account, windows, capturedAt);
                await syncCooldownFromWindows("anthropic", a.account, windows);
              },
            });
          }
        }
        // xAI: the Grok subscription usage endpoint also yields normalized windows
        // only. Keep the same best-effort semantics as Anthropic: a missing/empty
        // snapshot leaves the previous stored value intact, while a successful PULL
        // feeds both the durable store and the live pool's quota/cooldown view.
        const fetchXai = s.fetchXaiQuota;
        if (fetchXai) {
          for (const a of acctsOf("xai")) {
            tasks.push({
              label: `xai/${a.account}`,
              run: async () => {
                const windows = await fetchXai({ account: a.account, force: true });
                if (!windows || windows.length === 0) {
                  throw new Error("quota refresh returned no windows");
                }
                const capturedAt = Date.now();
                await recordResetBoundaries("xai", a.account, windows);
                await store.upsert({
                  providerId: "xai",
                  account: a.account,
                  windows,
                  capturedAt,
                  source: "xai",
                });
                deps.applyQuotaSnapshot?.("xai", a.account, windows, capturedAt);
                await syncCooldownFromWindows("xai", a.account, windows);
              },
            });
          }
        }
        // Codex: windows (persisted) + reset-credit count (live, attached below).
        const fetchCodex = s.fetchCodexQuota;
        if (fetchCodex) {
          for (const a of acctsOf("openai-codex")) {
            tasks.push({
              label: `openai-codex/${a.account}`,
              run: async () => {
                const persistCodexQuota = async (fresh: NonNullable<CodexQuotaResult>) => {
                  const activeResult = {
                    ...fresh,
                    windows: filterRetiredOpenAICodexLimits(fresh.windows),
                    additionalLimits: filterRetiredOpenAICodexLimits(fresh.additionalLimits),
                  };
                  const capturedAt = Date.now();
                  await recordResetBoundaries("openai-codex", a.account, activeResult.windows);
                  await store.upsert({
                    providerId: "openai-codex",
                    account: a.account,
                    windows: activeResult.windows,
                    capturedAt,
                    source: "codex",
                    resetCredits: activeResult.resetCredits,
                    // Persist the live metadata so the providers card survives a
                    // restart (the in-process cache alone is lost). readCachedQuota
                    // falls back to these when getCachedCodexQuota is cold.
                    planType: activeResult.planType,
                    credits: activeResult.credits,
                    resetCreditDetails: activeResult.resetCreditDetails,
                    individualLimit: activeResult.individualLimit,
                    additionalLimits: activeResult.additionalLimits,
                    rateLimitReachedType: activeResult.rateLimitReachedType,
                  });
                  deps.applyQuotaSnapshot?.(
                    "openai-codex",
                    a.account,
                    activeResult.windows,
                    capturedAt,
                    activeResult.resetCredits,
                  );
                  if (activeResult.windows.length > 0) {
                    await syncCooldownFromWindows("openai-codex", a.account, activeResult.windows);
                  }
                  return { activeResult, capturedAt };
                };

                const result = await fetchCodex({ account: a.account, force: true });
                if (!result) throw new Error("quota refresh returned no snapshot");
                const { activeResult, capturedAt } = await persistCodexQuota(result);
                if (weeklySaturated(activeResult.windows)) {
                  const consumed =
                    (await deps.onCodexQuotaSaturated?.(
                      "openai-codex",
                      a.account,
                      activeResult.windows,
                      capturedAt,
                      activeResult.rateLimitReachedType ?? null,
                    )) ?? false;
                  if (consumed) {
                    const refreshed = await fetchCodex({ account: a.account, force: true });
                    if (!refreshed) {
                      throw new Error("post-reset quota refresh returned no snapshot");
                    }
                    await persistCodexQuota(refreshed);
                  }
                }
              },
            });
          }
        }
        for (const task of tasks) {
          try {
            await task.run();
          } catch (error) {
            failures.push(`${task.label}: ${errMessage(error)}`);
          }
        }
      } catch (error) {
        failures.push(`provider status: ${errMessage(error)}`);
      }
    }
    const all = await store.getAll().catch((error: unknown) => {
      failures.push(`quota cache: ${errMessage(error)}`);
      return [];
    });
    if (bound) {
      // Best-effort prune so orphans don't accumulate. A delete failure does not
      // discard fresh rows or hide a successful provider pull.
      await Promise.all(
        all
          .filter((q) => !bound.has(acctKey(q.providerId, q.account)))
          .map((o) => store.delete(o.providerId, o.account).catch(() => {})),
      );
    }
    if (failures.length > 0) {
      throw new Error(`provider refresh failed (${failures.join("; ")})`);
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
    } catch {
      return [];
    }
  };

  const refreshCoordinator = createOAuthAdminRefreshCoordinator({
    refresh: async () => {
      await refreshQuota();
    },
    ...(deps.runInBackground !== undefined ? { runInBackground: deps.runInBackground } : {}),
  });

  app.get("/admin/api/oauth/usage", async (c) => {
    const status = await seam()
      ?.listCachedStatus()
      .catch(() => null);
    return c.json({ usage: await readUsage(c.req.query("tzOffsetMinutes"), status ?? null) });
  });

  // GET /oauth/usage/periods?provider=&account=&tzOffsetMinutes= -> the account-detail
  // page: current reset-period summary + natural day/week history. provider+account
  // required; tzOffsetMinutes (the viewer's local offset) shapes the calendar buckets.
  app.get("/admin/api/oauth/usage/periods", async (c) => {
    const provider = c.req.query("provider");
    const account = c.req.query("account");
    if (!provider || !account) {
      return c.json({ error: "provider and account are required" }, 400);
    }
    return c.json(await readPeriods(provider, account, c.req.query("tzOffsetMinutes")));
  });

  app.get("/admin/api/oauth/quota", async (c) => {
    const status = await seam()
      ?.listCachedStatus()
      .catch(() => null);
    return c.json({ quota: await readCachedQuota(status ?? null) });
  });

  // The providers page uses one cache-only round trip for account, usage, quota,
  // and refresh-job state. A cold upstream or dead proxy cannot delay this route.
  app.get("/admin/api/oauth/overview", async (c) => {
    const s = seam();
    if (!s) {
      return c.json({
        configured: false,
        selectionStrategy: "balanced",
        providers: [],
        usage: [],
        quota: [],
        refresh: refreshCoordinator.status(),
      });
    }
    const status = await s.listCachedStatus();
    const [usage, quota] = await Promise.all([
      readUsage(c.req.query("tzOffsetMinutes"), status),
      readCachedQuota(status),
    ]);
    return c.json({
      configured: true,
      ...status,
      usage,
      quota,
      refresh: refreshCoordinator.status(),
    });
  });

  app.post("/admin/api/oauth/refresh", (c) => {
    if (!seam()) return c.json({ error: "oauth login not configured" }, 503);
    const result = refreshCoordinator.enqueue();
    if (result.retryAfterMs > 0) {
      c.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    }
    return c.json(result, 202);
  });

  // POST /oauth/:provider/reset-credit { account? } -> consume one rate-limit reset
  // credit for the account (the "reset usage limit" action). Codex-only. FAIL-CLOSED:
  // the seam THROWS on any upstream failure, surfaced here as a 502 so the operator
  // sees a real error rather than a silent no-op. Returns the normalized four-way
  // outcome together with the upstream code and restored-window count.
  app.post("/admin/api/oauth/:provider/reset-credit", async (c) => {
    const s = seam();
    const consumeCodexResetCredit = s?.consumeCodexResetCredit;
    if (!consumeCodexResetCredit) {
      return c.json({ error: "oauth login not configured" }, 503);
    }
    const providerId = c.req.param("provider");
    if (providerId !== "openai-codex") {
      return c.json({ error: "reset credit is only supported for openai-codex" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      account?: unknown;
      creditId?: unknown;
      idempotencyKey?: unknown;
    };
    const account =
      typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT;
    const creditId = typeof body.creditId === "string" ? body.creditId : undefined;
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
    if (creditId !== undefined && creditId.length === 0) {
      return c.json({ error: "creditId must not be empty" }, 400);
    }
    if (idempotencyKey !== undefined && idempotencyKey.length === 0) {
      return c.json({ error: "idempotencyKey must not be empty" }, 400);
    }
    const snapshot = await deps.oauthQuota?.get(providerId, account).catch(() => null);
    const liveQuota = await s.fetchCodexQuota?.({ account }).catch(() => null);
    const snapshotWindows = filterRetiredOpenAICodexLimits(snapshot?.windows);
    const liveWindows = filterRetiredOpenAICodexLimits(liveQuota?.windows);
    const windows = snapshotWindows.length > 0 ? snapshotWindows : liveWindows;
    if (windows.length === 0) {
      return c.json(
        {
          error: "reset credit blocked: Codex weekly quota snapshot is unavailable",
          code: "quota_unavailable",
        },
        409,
      );
    }
    const rateLimitReachedType = liveQuota?.rateLimitReachedType ?? null;
    const weeklyUsedPercent = codexWeeklyUsedPercent(windows);
    if (!canConsumeResetCredit(windows, rateLimitReachedType)) {
      const reachedTypeBlocks =
        rateLimitReachedType !== null && rateLimitReachedType !== "rate_limit_reached";
      return c.json(
        {
          error: reachedTypeBlocks
            ? "reset credit blocked: this Codex limit cannot be restored with a rate-limit reset credit"
            : `reset credit blocked: Codex weekly usage must be at least ${CODEX_RESET_MIN_WEEKLY_USED_PERCENT}%`,
          code: reachedTypeBlocks
            ? "reset_credit_not_applicable"
            : "weekly_usage_below_reset_threshold",
          weeklyUsedPercent,
          minWeeklyUsedPercent: CODEX_RESET_MIN_WEEKLY_USED_PERCENT,
        },
        409,
      );
    }
    const guard = deps.resetCreditGuard;
    if (!guard) {
      return c.json(
        { error: "reset credit guard is not configured", code: "reset_credit_guard_unavailable" },
        503,
      );
    }
    const reservation = await guard.reserve({
      providerId,
      account,
      windows,
      mode: "manual",
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      rateLimitReachedType,
    });
    if (!reservation.ok) {
      if (reservation.retryAfterMs !== undefined) {
        c.header("Retry-After", String(Math.ceil(reservation.retryAfterMs / 1000)));
      }
      return c.json(
        {
          error: reservation.error,
          code: reservation.code,
          ...(reservation.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: reservation.retryAfterMs }),
        },
        reservation.status,
      );
    }
    try {
      const { result } = await runResetCreditAttempt({
        reservation,
        consume: () =>
          consumeCodexResetCredit({
            account,
            ...(creditId === undefined ? {} : { creditId }),
            idempotencyKey: reservation.idempotencyKey,
          }),
        onConsumed: (result) =>
          deps.onCodexQuotaResetConsumed?.(
            "openai-codex",
            account,
            windows,
            "manual",
            result.outcome === "reset" ? Date.now() : null,
          ),
      });
      return c.json(result, 200);
    } catch (e) {
      // Upstream said no (no credits, expired token, network) — not a client error.
      return c.json({ error: errMessage(e) }, 502);
    }
  });

  // POST /oauth/:provider/manual/start { proxy? } -> { sessionId, authorizeUrl }
  // An optional egress proxy entered in the connect dialog's first step is pinned to
  // the login session so the token exchange never leaves from the real IP (issue #38).
  app.post("/admin/api/oauth/:provider/manual/start", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { proxy?: unknown };
    let proxy: AccountProxyInput | null;
    try {
      proxy = parseProxyInput(body.proxy);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
    try {
      return c.json(
        await s.startManualPaste({
          providerId: c.req.param("provider"),
          proxy: proxy ?? undefined,
        }),
      );
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // POST /oauth/:provider/manual/complete { sessionId, redirectInput, account? }
  app.post("/admin/api/oauth/:provider/manual/complete", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: unknown;
      redirectInput?: unknown;
      account?: unknown;
    };
    if (typeof body.sessionId !== "string" || typeof body.redirectInput !== "string") {
      return c.json({ error: "sessionId and redirectInput are required" }, 400);
    }
    try {
      const providerId = c.req.param("provider");
      const account =
        typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT;
      await s.completeManualPaste({
        sessionId: body.sessionId,
        redirectInput: body.redirectInput,
        account,
      });
      if (!(await clearDurableQuota(providerId, account))) return c.json(notApplied, 503);
      // A completed login adds/refreshes an account → rebuild the routable pool.
      if (!(await afterMutation())) return c.json(notApplied, 503);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // POST /oauth/:provider/device/start { enterprise?, proxy? }
  //   -> { sessionId, userCode, verificationUri, intervalMs, expiresAt, serverNowMs }
  // The proxy is pinned BEFORE the device-code POST (the flow's first call), so step
  // 1 already egresses through it — no real-IP leak at bind time (issue #38).
  app.post("/admin/api/oauth/:provider/device/start", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as {
      enterprise?: unknown;
      proxy?: unknown;
    };
    let proxy: AccountProxyInput | null;
    try {
      proxy = parseProxyInput(body.proxy);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
    try {
      return c.json(
        await s.startDeviceCode({
          providerId: c.req.param("provider"),
          enterprise: typeof body.enterprise === "string" ? body.enterprise : undefined,
          proxy: proxy ?? undefined,
        }),
      );
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // POST /oauth/:provider/device/poll { sessionId, account? } -> { status }
  app.post("/admin/api/oauth/:provider/device/poll", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: unknown;
      account?: unknown;
    };
    if (typeof body.sessionId !== "string") {
      return c.json({ error: "sessionId is required" }, 400);
    }
    try {
      const providerId = c.req.param("provider");
      const account =
        typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT;
      const result = await s.pollDeviceCode({
        sessionId: body.sessionId,
        account,
      });
      // Only a COMPLETED device login mutates the credential set → rebuild then.
      if (result.status === "done") {
        if (!(await clearDurableQuota(providerId, account))) return c.json(notApplied, 503);
        if (!(await afterMutation())) return c.json(notApplied, 503);
      }
      return c.json(result);
    } catch (e) {
      return c.json({ error: errMessage(e), code: devicePollErrorCode(e) }, 400);
    }
  });

  // GET /oauth/:provider/models?account=... -> { available, enabled }
  // The discovered models for one account + the operator's exposed subset.
  app.get("/admin/api/oauth/:provider/models", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const account = c.req.query("account") || DEFAULT_ACCOUNT;
    try {
      return c.json(await s.listModels({ providerId: c.req.param("provider"), account }));
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // PUT /oauth/:provider/models { account?, models: string[] } -> 204
  // Persist which discovered models this account exposes to Lanes.
  app.put("/admin/api/oauth/:provider/models", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as {
      account?: unknown;
      mode?: unknown;
      models?: unknown;
    };
    if (!Array.isArray(body.models) || body.models.some((m) => typeof m !== "string")) {
      return c.json({ error: "models must be an array of strings" }, 400);
    }
    if (body.mode !== undefined && body.mode !== "auto" && body.mode !== "manual") {
      return c.json({ error: "mode must be 'auto' or 'manual'" }, 400);
    }
    try {
      await s.setEnabledModels({
        providerId: c.req.param("provider"),
        account: typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT,
        mode: body.mode === "auto" ? "auto" : "manual",
        models: body.models as string[],
      });
      if (!(await afterMutation())) return c.json(notApplied, 503);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // GET /oauth/:provider/proxy?account=... -> AccountProxyView | null
  // The account's egress proxy (issue #38 follow-up). NEVER returns the password —
  // only `hasPassword`. null = no proxy (direct connection).
  app.get("/admin/api/oauth/:provider/proxy", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const account = c.req.query("account") || DEFAULT_ACCOUNT;
    try {
      return c.json({
        proxy: await s.getAccountProxy({ providerId: c.req.param("provider"), account }),
      });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // PUT /oauth/:provider/proxy { account?, proxy: {type,host,port,username?,password?} | null } -> 204
  // Persist or CLEAR (proxy: null) the account's egress proxy. A malformed proxy is
  // rejected (400) and never persisted (fail-closed). An omitted password on an
  // update preserves the stored one (the seam resolves it).
  app.put("/admin/api/oauth/:provider/proxy", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as {
      account?: unknown;
      proxy?: unknown;
    };
    const account =
      typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT;
    // null = clear the proxy (direct connection); an object = set it. Same parse the
    // connect-start routes use, so a malformed proxy is rejected identically.
    let proxy: AccountProxyInput | null;
    try {
      proxy = parseProxyInput(body.proxy);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
    try {
      await s.setAccountProxy({ providerId: c.req.param("provider"), account, proxy });
      // Rebuild so the new egress proxy is applied to this account's client now.
      if (!(await afterMutation())) return c.json(notApplied, 503);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // GET /oauth/:provider/account?account=... -> AccountScheduleView
  // The account's effective scheduling (priority + schedulable; defaults applied).
  app.get("/admin/api/oauth/:provider/account", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const account = c.req.query("account") || DEFAULT_ACCOUNT;
    try {
      return c.json(await s.getAccountSchedule({ providerId: c.req.param("provider"), account }));
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // PUT /oauth/:provider/account { account?, priority?, schedulable?, autoReset?, allowSpendRemainingCredits?, fastMode? } -> 204
  // Persist the account's pool scheduling. priority must be a finite integer; either
  // field may be omitted to leave it unchanged (fail-closed on a malformed value).
  app.put("/admin/api/oauth/:provider/account", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as {
      account?: unknown;
      priority?: unknown;
      schedulable?: unknown;
      autoReset?: unknown;
      allowSpendRemainingCredits?: unknown;
      fastMode?: unknown;
    };
    const account =
      typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT;
    let priority: number | undefined;
    if (body.priority !== undefined) {
      // Non-negative integer (fail-closed): a negative priority would always win pool
      // scheduling — reject it here so no client (incl. the inline UI editor) can
      // persist one. LOWER = preferred; 0 is the most-preferred valid value.
      if (
        typeof body.priority !== "number" ||
        !Number.isInteger(body.priority) ||
        body.priority < 0
      ) {
        return c.json({ error: "priority must be a non-negative integer" }, 400);
      }
      priority = body.priority;
    }
    let schedulable: boolean | undefined;
    if (body.schedulable !== undefined) {
      if (typeof body.schedulable !== "boolean") {
        return c.json({ error: "schedulable must be a boolean" }, 400);
      }
      schedulable = body.schedulable;
    }
    let autoReset: boolean | undefined;
    if (body.autoReset !== undefined) {
      if (typeof body.autoReset !== "boolean") {
        return c.json({ error: "autoReset must be a boolean" }, 400);
      }
      autoReset = body.autoReset;
    }
    let allowSpendRemainingCredits: boolean | undefined;
    if (body.allowSpendRemainingCredits !== undefined) {
      if (typeof body.allowSpendRemainingCredits !== "boolean") {
        return c.json({ error: "allowSpendRemainingCredits must be a boolean" }, 400);
      }
      allowSpendRemainingCredits = body.allowSpendRemainingCredits;
    }
    let fastMode: boolean | undefined;
    if (body.fastMode !== undefined) {
      if (typeof body.fastMode !== "boolean") {
        return c.json({ error: "fastMode must be a boolean" }, 400);
      }
      fastMode = body.fastMode;
    }
    try {
      await s.setAccountSchedule({
        providerId: c.req.param("provider"),
        account,
        priority,
        schedulable,
        autoReset,
        allowSpendRemainingCredits,
        fastMode,
      });
      // Rebuild so the new priority / schedulable reorders (or parks) this account now.
      if (!(await afterMutation())) return c.json(notApplied, 503);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // GET /oauth/strategy -> { selectionStrategy }
  // Global strategy for selecting BETWEEN connected accounts inside each provider
  // pool. Lanes/Policies still choose the model/provider chain.
  app.get("/admin/api/oauth/strategy", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    try {
      return c.json(await s.getSelectionStrategy());
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // PUT /oauth/strategy { selectionStrategy } -> 204
  // Changing the strategy rebuilds every live OAuth pool so the next request uses it.
  app.put("/admin/api/oauth/strategy", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { selectionStrategy?: unknown };
    const selectionStrategy = parseSelectionStrategy(body.selectionStrategy);
    if (selectionStrategy === null) {
      return c.json(
        { error: "selectionStrategy must be balanced, manual_priority, low_risk, or use_expiring" },
        400,
      );
    }
    try {
      await s.setSelectionStrategy({ selectionStrategy });
      if (!(await afterMutation())) return c.json(notApplied, 503);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // POST /oauth/:provider/test -> SSE connectivity check for ONE account. Streams a
  // single short completion through a FRESH isolated client (deps.oauthTester) and
  // relays normalized events so the admin UI shows the real, streamed reply — not a
  // bare "ok". Fail-open (Principle 3): a missing tester 503s before streaming;
  // missing account/model 400s; any upstream failure is surfaced as an in-band
  // `error` event (HTTP 200, never a 5xx) so the dialog can show what went wrong. A
  // client/modal abort is silent (not a provider fault). No request telemetry is
  // recorded — the fresh client carries its own no-op breaker (see oauth-test.ts).
  // A SUCCESSFUL test still consumes real upstream quota, so record OAuth account
  // usage and clear any stale auto-park cooldown.
  app.post("/admin/api/oauth/:provider/test", async (c) => {
    const tester = deps.oauthTester;
    if (!tester) return c.json({ error: "oauth login not configured" }, 503);
    const providerId = c.req.param("provider");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const account = typeof body.account === "string" ? body.account : "";
    const model = typeof body.model === "string" ? body.model : "";
    const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
    if (!account) return c.json({ error: "account is required" }, 400);
    if (!model) return c.json({ error: "model is required" }, 400);
    if (GROK_OAUTH_MEDIA_MODELS.some((mediaModel) => mediaModel === model)) {
      return c.json({ error: "media models are not supported by the chat connectivity test" }, 400);
    }
    const signal = c.req.raw.signal;
    return streamSSE(c, async (sse) => {
      const startedAt = Date.now();
      let tokens = 0;
      await sse.writeSSE({ data: JSON.stringify({ type: "start", model }) });
      try {
        for await (const ev of tester.test({ providerId, account, model, prompt, signal })) {
          const usageTokens = testUsageTokens(ev);
          if (usageTokens !== null) tokens = usageTokens;
          await sse.writeSSE({ data: JSON.stringify(ev) });
        }
        const nowMs = Date.now();
        await deps.oauthUsage
          ?.record({
            providerId,
            account,
            bucketMs: nowMs - (nowMs % 3_600_000),
            tokens,
            costUsd: null,
            nowMs,
          })
          .catch(() => {});
        await deps.applyUsageLimit?.(providerId, account, null, "replace").catch(() => {});
        await sse.writeSSE({
          data: JSON.stringify({ type: "done", durationMs: Date.now() - startedAt }),
        });
      } catch (e) {
        // A client disconnect / modal close is not a provider failure — stay quiet.
        if (isAbort(e, signal)) return;
        await recordCredentialFailure(deps, providerId, account, e);
        await sse.writeSSE({ data: JSON.stringify({ type: "error", error: errMessage(e) }) });
      }
    });
  });

  // DELETE /oauth/:provider?account=... -> 204 (log out / forget a credential)
  app.delete("/admin/api/oauth/:provider", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const account = c.req.query("account") || DEFAULT_ACCOUNT;
    const providerId = c.req.param("provider");
    let logoutError: unknown;
    let logoutSucceeded = false;
    try {
      await s.logout({ providerId, account });
      logoutSucceeded = true;
    } catch (error) {
      logoutError = error;
    }
    // Only a fully successful seam logout proves that the credential is absent.
    // A failure may have happened before OR after token deletion, so preserve the
    // durable quota until the next authoritative refresh instead of guessing.
    const quotaCleared = logoutSucceeded ? await clearDurableQuota(providerId, account) : true;
    // Disconnect removes an account → rebuild so it leaves the pool immediately.
    // This MUST run even when quota cleanup failed: the credential is already gone,
    // while the old live member may still hold/refresh an in-memory access token.
    // It also MUST run after an ambiguous logout failure: rebuilding from durable
    // token truth either removes a partially-deleted account or safely retains one
    // whose token deletion never happened.
    const rebuilt = await afterMutation();
    if (!logoutSucceeded) {
      return c.json({ error: errMessage(logoutError), code: "logout_failed" }, 500);
    }
    if (!quotaCleared || !rebuilt) return c.json(notApplied, 503);
    return c.body(null, 204);
  });

  // POST /oauth/:provider/reset?account=... -> 204 ("Reset usage")
  // Codex-only local cooldown override: clear Helm's AUTO-park usage-limit cooldown
  // so the account rejoins the pool on the next request. Clears ONLY the cooldown
  // (live member + persisted) — an operator-parked (schedulable=false) account stays
  // parked. Claude's 5h/7d subscription windows are upstream limits, so they are not
  // exposed here as resettable. No rebuild needed: applyUsageLimit flips the live
  // member in place. 503 when OAuth is disabled (no seam), matching /oauth/* routes.
  app.post("/admin/api/oauth/:provider/reset", async (c) => {
    const s = seam();
    if (!s || !deps.applyUsageLimit) return c.json({ error: "oauth login not configured" }, 503);
    const providerId = c.req.param("provider");
    if (providerId !== "openai-codex") {
      return c.json({ error: "usage reset is only supported for openai-codex" }, 400);
    }
    const account = c.req.query("account") || DEFAULT_ACCOUNT;
    try {
      await deps.applyUsageLimit(providerId, account, null);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });
}
