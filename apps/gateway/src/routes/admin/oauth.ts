import { windowsToActiveUsageRecovery } from "@helm/core";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../../app.js";
import {
  CODEX_RESET_MIN_WEEKLY_USED_PERCENT,
  canConsumeResetCredit,
  codexWeeklyUsedPercent,
} from "../../oauth/auto-reset.js";
import type {
  AccountProxyInput,
  AdminApiDeps,
  OAuthAdminAccess,
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

// Narrow an unknown thrown value to a safe, already-scrubbed message. The seam's
// errors are constructed without token material (TokenRefreshError / generic),
// so echoing the message is safe; anything else degrades to a generic string.
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "oauth request failed";
}

// A client disconnect / modal close surfaces as an aborted signal or an AbortError.
// Treated as NOT a provider failure (Principle: client disconnect ≠ upstream fault),
// so the /test stream ends silently instead of emitting a spurious error event.
function isAbort(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
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

  // GET /oauth -> provider catalog + which accounts are logged in (no secrets).
  app.get("/admin/api/oauth", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured (set HELM_OAUTH_ENC_KEY)" }, 503);
    return c.json(await s.listStatus());
  });

  // GET /oauth/usage?tzOffsetMinutes -> today's per-account served traffic (providers
  // page Tier 2). FAIL-OPEN: an absent store / read failure yields [] (the page
  // renders zeros) — an observability read must never break the page. "Today" is the
  // ADMIN's LOCAL day: the browser sends its UTC offset (east-positive minutes) and
  // we roll the per-hour buckets up over [local-midnight, +24h) in UTC. A missing /
  // out-of-range offset fails open to 0 (UTC day). RPM is the daily AVERAGE (requests
  // / minutes since the day's first served call), derived here so the store stays a
  // plain counter. No secrets — aggregate counters only (principle 7).
  app.get("/admin/api/oauth/usage", async (c) => {
    const store = deps.oauthUsage;
    if (!store) return c.json({ usage: [] });
    const now = Date.now();
    // Fail-open tz offset (east-positive minutes; UTC-12 … UTC+14). Then floor to the
    // viewer's local midnight and express that boundary back in UTC for the query.
    const rawTz = Number(c.req.query("tzOffsetMinutes"));
    const tzOffsetMinutes = Number.isInteger(rawTz) && rawTz >= -720 && rawTz <= 840 ? rawTz : 0;
    const offsetMs = tzOffsetMinutes * 60_000;
    const start = now + offsetMs - ((now + offsetMs) % 86_400_000) - offsetMs;
    const end = start + 86_400_000;
    // Restrict to currently-bound accounts (listStatus = the OAuth tokens) so a
    // renamed / re-bound account does NOT linger as a phantom usage row — the same
    // guard the /quota route applies. Fail-open: no seam / a listing failure leaves
    // `bound` null and every row is returned (never hide data behind the filter).
    const usageKey = (providerId: string, account: string) => JSON.stringify([providerId, account]);
    let bound: Set<string> | null = null;
    const s = seam();
    if (s) {
      try {
        const status = await s.listStatus();
        bound = new Set(
          status.providers.flatMap((p) => p.accounts.map((a) => usageKey(p.id, a.account))),
        );
      } catch {
        // fail-open: a listing failure returns all rows rather than hiding data
      }
    }
    try {
      const rows = await store.queryRange(start, end);
      const usage = rows
        .filter((r) => !bound || bound.has(usageKey(r.providerId, r.account)))
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
      return c.json({ usage });
    } catch {
      return c.json({ usage: [] });
    }
  });

  // GET /oauth/quota -> latest rate-limit window snapshot per account (providers
  // page Tier 3). Sources merge in the quota store: Codex PUSHes `x-codex-*`
  // headers on every reply, and BOTH Anthropic and Codex expose PULL usage
  // endpoints we refresh on read (5-min cached in the seam) before returning.
  // FAIL-OPEN throughout — a dead token / absent store yields fewer windows or
  // [], never an error.
  app.get("/admin/api/oauth/quota", async (c) => {
    const store = deps.oauthQuota;
    if (!store) return c.json({ quota: [] });
    const s = seam();
    // listStatus (the bound OAuth tokens) is the source of truth for "which accounts
    // exist". We use it BOTH to refresh the Anthropic PULL and to drop ORPHANED
    // snapshots: a renamed / logged-out account otherwise leaves a stale row (e.g. a
    // Codex push captured under an old label) that would show as a phantom account.
    const acctKey = (providerId: string, account: string) => `${providerId}\u0000${account}`;
    let bound: Set<string> | null = null;
    // Codex reset-credit counts, surfaced LIVE (never persisted — the value drops the
    // instant a credit is consumed, so a stored snapshot would lie). Keyed by acctKey;
    // attached onto the matching codex snapshot in the response below.
    const resetCredits = new Map<string, number | null>();
    const syncActiveCooldownFromWindows = async (
      providerId: string,
      account: string,
      windows: Parameters<typeof windowsToActiveUsageRecovery>[0],
    ): Promise<void> => {
      if (!deps.applyUsageLimit) return;
      const nowMs = Date.now();
      const current = await store.get(providerId, account).catch(() => null);
      const currentUntil = current?.usageLimitedUntilMs ?? null;
      if (currentUntil === null || currentUntil <= nowMs) return;
      const quotaUntil = windowsToActiveUsageRecovery(windows, nowMs);
      if (quotaUntil === null) {
        await deps.applyUsageLimit(providerId, account, null, "replace").catch(() => {});
        return;
      }
      if (currentUntil === quotaUntil) return;
      await deps.applyUsageLimit(providerId, account, quotaUntil, "replace").catch(() => {});
    };
    if (s) {
      try {
        const status = await s.listStatus();
        bound = new Set(
          status.providers.flatMap((p) => p.accounts.map((a) => acctKey(p.id, a.account))),
        );
        // Refresh the usage-endpoint PULL for each connected account (cached in the
        // seam). Anthropic and Codex both expose one; the Codex `x-codex-*` header
        // PUSH still updates the same store on live traffic — the PULL covers
        // accounts that have served nothing yet (else they render "—" forever).
        // NB: this observability PULL refreshes the stored window snapshot (and, for
        // Codex, the live reset-credit count) but does NOT newly auto-park an otherwise
        // active account. If the account is ALREADY parked by live-traffic evidence
        // (generic 429 fallback), a near-full quota window may EXTEND that cooldown to
        // the likely reset time. That keeps "Reset usage" effective: clearing the
        // cooldown then reloading this page does not immediately re-park the account
        // before it can serve a single request. For an ALREADY parked account, a
        // successful PULL is also trusted to clear or shorten stale cooldowns: clean
        // windows mean the account is available again.
        const acctsOf = (id: string) => status.providers.find((x) => x.id === id)?.accounts ?? [];
        const tasks: Array<Promise<void>> = [];
        // Anthropic: windows only.
        const fetchAnthropic = s.fetchAnthropicQuota;
        if (fetchAnthropic) {
          for (const a of acctsOf("anthropic")) {
            tasks.push(
              (async () => {
                const windows = await fetchAnthropic({ account: a.account });
                if (windows && windows.length > 0) {
                  await store
                    .upsert({
                      providerId: "anthropic",
                      account: a.account,
                      windows,
                      capturedAt: Date.now(),
                      source: "anthropic",
                    })
                    .catch(() => {});
                  await syncActiveCooldownFromWindows("anthropic", a.account, windows);
                }
              })(),
            );
          }
        }
        // Codex: windows (persisted) + reset-credit count (live, attached below).
        const fetchCodex = s.fetchCodexQuota;
        if (fetchCodex) {
          for (const a of acctsOf("openai-codex")) {
            tasks.push(
              (async () => {
                const result = await fetchCodex({ account: a.account });
                if (!result) return;
                resetCredits.set(acctKey("openai-codex", a.account), result.resetCredits);
                if (result.windows.length > 0) {
                  await store
                    .upsert({
                      providerId: "openai-codex",
                      account: a.account,
                      windows: result.windows,
                      capturedAt: Date.now(),
                      source: "codex",
                    })
                    .catch(() => {});
                  await syncActiveCooldownFromWindows("openai-codex", a.account, result.windows);
                }
              })(),
            );
          }
        }
        await Promise.all(tasks);
      } catch {
        // fail-open: a refresh/listing failure still returns whatever is stored
      }
    }
    // Fold the live codex reset-credit count onto its snapshot (no-op for others).
    const withCredits = <T extends { providerId: string; account: string }>(q: T) => {
      const credits = resetCredits.get(acctKey(q.providerId, q.account));
      return credits === undefined ? q : { ...q, resetCredits: credits };
    };
    try {
      const all = await store.getAll();
      // No binding view (no seam / listStatus failed) → fail-open, return everything.
      if (!bound) return c.json({ quota: all.map(withCredits) });
      const live = all.filter((q) => bound.has(acctKey(q.providerId, q.account)));
      // Best-effort prune so orphans don't accumulate; never block the read on it.
      await Promise.all(
        all
          .filter((q) => !bound.has(acctKey(q.providerId, q.account)))
          .map((o) => store.delete(o.providerId, o.account).catch(() => {})),
      );
      return c.json({ quota: live.map(withCredits) });
    } catch {
      return c.json({ quota: [] });
    }
  });

  // POST /oauth/:provider/reset-credit { account? } -> consume one rate-limit reset
  // credit for the account (the "reset usage limit" action). Codex-only. FAIL-CLOSED:
  // the seam THROWS on any upstream failure, surfaced here as a 502 so the operator
  // sees a real error rather than a silent no-op. Returns { code, windowsReset }.
  app.post("/admin/api/oauth/:provider/reset-credit", async (c) => {
    const s = seam();
    if (!s?.consumeCodexResetCredit) {
      return c.json({ error: "oauth login not configured" }, 503);
    }
    const providerId = c.req.param("provider");
    if (providerId !== "openai-codex") {
      return c.json({ error: "reset credit is only supported for openai-codex" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { account?: unknown };
    const account =
      typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT;
    const snapshot = await deps.oauthQuota?.get(providerId, account).catch(() => null);
    if (!snapshot) {
      return c.json(
        {
          error: "reset credit blocked: Codex weekly quota snapshot is unavailable",
          code: "quota_unavailable",
        },
        409,
      );
    }
    const weeklyUsedPercent = codexWeeklyUsedPercent(snapshot.windows);
    if (!canConsumeResetCredit(snapshot.windows)) {
      return c.json(
        {
          error: `reset credit blocked: Codex weekly usage must be at least ${CODEX_RESET_MIN_WEEKLY_USED_PERCENT}%`,
          code: "weekly_usage_below_reset_threshold",
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
      windows: snapshot.windows,
      mode: "manual",
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
      const result = await s.consumeCodexResetCredit({ account });
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
      await s.completeManualPaste({
        sessionId: body.sessionId,
        redirectInput: body.redirectInput,
        account: typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT,
      });
      // A completed login adds/refreshes an account → rebuild the routable pool.
      if (!(await afterMutation())) return c.json(notApplied, 503);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // POST /oauth/:provider/device/start { enterprise?, proxy? } -> { sessionId, userCode, verificationUri }
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
      const result = await s.pollDeviceCode({
        sessionId: body.sessionId,
        account: typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT,
      });
      // Only a COMPLETED device login mutates the credential set → rebuild then.
      if (result.status === "done") await afterMutation();
      return c.json(result);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
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
      models?: unknown;
    };
    if (!Array.isArray(body.models) || body.models.some((m) => typeof m !== "string")) {
      return c.json({ error: "models must be an array of strings" }, 400);
    }
    try {
      await s.setEnabledModels({
        providerId: c.req.param("provider"),
        account: typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT,
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

  // PUT /oauth/:provider/account { account?, priority?, schedulable?, autoReset?, fastMode? } -> 204
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
        await sse.writeSSE({ data: JSON.stringify({ type: "error", error: errMessage(e) }) });
      }
    });
  });

  // DELETE /oauth/:provider?account=... -> 204 (log out / forget a credential)
  app.delete("/admin/api/oauth/:provider", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const account = c.req.query("account") || DEFAULT_ACCOUNT;
    await s.logout({ providerId: c.req.param("provider"), account });
    // Disconnect removes an account → rebuild so it leaves the pool immediately.
    if (!(await afterMutation())) return c.json(notApplied, 503);
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
