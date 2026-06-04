import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps, OAuthAdminAccess } from "./deps.js";

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
    return c.json({ providers: await s.listStatus() });
  });

  // GET /oauth/usage -> today's per-account served traffic (providers page Tier 2).
  // FAIL-OPEN: an absent store / read failure yields [] (the page renders zeros) —
  // an observability read must never break the page. RPM is the daily AVERAGE
  // (requests / minutes since the day's first served call), derived here so the
  // store stays a plain counter. No secrets — aggregate counters only (principle 7).
  app.get("/admin/api/oauth/usage", async (c) => {
    const store = deps.oauthUsage;
    if (!store) return c.json({ usage: [] });
    const now = Date.now();
    const dayMs = now - (now % 86_400_000); // UTC midnight (epoch ms is UTC)
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
        bound = new Set(status.flatMap((p) => p.accounts.map((a) => usageKey(p.id, a.account))));
      } catch {
        // fail-open: a listing failure returns all rows rather than hiding data
      }
    }
    try {
      const rows = await store.queryDay(dayMs);
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
    if (s) {
      try {
        const status = await s.listStatus();
        bound = new Set(status.flatMap((p) => p.accounts.map((a) => acctKey(p.id, a.account))));
        // Refresh the usage-endpoint PULL for each connected account (cached in the
        // seam). Anthropic and Codex both expose one; the Codex `x-codex-*` header
        // PUSH still updates the same store on live traffic — the PULL covers
        // accounts that have served nothing yet (else they render "—" forever).
        const pulls = [
          { providerId: "anthropic", source: "anthropic" as const, fetch: s.fetchAnthropicQuota },
          { providerId: "openai-codex", source: "codex" as const, fetch: s.fetchCodexQuota },
        ];
        await Promise.all(
          pulls.flatMap((p) => {
            if (!p.fetch) return [];
            const accounts = status.find((x) => x.id === p.providerId)?.accounts ?? [];
            return accounts.map(async (a) => {
              const windows = await p.fetch?.({ account: a.account });
              if (windows && windows.length > 0) {
                await store
                  .upsert({
                    providerId: p.providerId,
                    account: a.account,
                    windows,
                    capturedAt: Date.now(),
                    source: p.source,
                  })
                  .catch(() => {});
              }
            });
          }),
        );
      } catch {
        // fail-open: a refresh/listing failure still returns whatever is stored
      }
    }
    try {
      const all = await store.getAll();
      // No binding view (no seam / listStatus failed) → fail-open, return everything.
      if (!bound) return c.json({ quota: all });
      const live = all.filter((q) => bound.has(acctKey(q.providerId, q.account)));
      // Best-effort prune so orphans don't accumulate; never block the read on it.
      await Promise.all(
        all
          .filter((q) => !bound.has(acctKey(q.providerId, q.account)))
          .map((o) => store.delete(o.providerId, o.account).catch(() => {})),
      );
      return c.json({ quota: live });
    } catch {
      return c.json({ quota: [] });
    }
  });

  // POST /oauth/:provider/manual/start -> { sessionId, authorizeUrl }
  app.post("/admin/api/oauth/:provider/manual/start", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    try {
      return c.json(await s.startManualPaste({ providerId: c.req.param("provider") }));
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

  // POST /oauth/:provider/device/start { enterprise? } -> { sessionId, userCode, verificationUri }
  app.post("/admin/api/oauth/:provider/device/start", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { enterprise?: unknown };
    try {
      return c.json(
        await s.startDeviceCode({
          providerId: c.req.param("provider"),
          enterprise: typeof body.enterprise === "string" ? body.enterprise : undefined,
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
    let proxy: Parameters<NonNullable<typeof s>["setAccountProxy"]>[0]["proxy"];
    if (body.proxy === null || body.proxy === undefined) {
      proxy = null;
    } else if (typeof body.proxy === "object") {
      const p = body.proxy as Record<string, unknown>;
      if (
        (p.type !== "http" && p.type !== "https" && p.type !== "socks5") ||
        typeof p.host !== "string" ||
        typeof p.port !== "number"
      ) {
        return c.json({ error: "proxy requires type (http|https|socks5), host, port" }, 400);
      }
      proxy = {
        type: p.type,
        host: p.host,
        port: p.port,
        ...(typeof p.username === "string" ? { username: p.username } : {}),
        ...(typeof p.password === "string" ? { password: p.password } : {}),
      };
    } else {
      return c.json({ error: "proxy must be an object or null" }, 400);
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

  // PUT /oauth/:provider/account { account?, priority?, schedulable? } -> 204
  // Persist the account's pool scheduling. priority must be a finite integer; either
  // field may be omitted to leave it unchanged (fail-closed on a malformed value).
  app.put("/admin/api/oauth/:provider/account", async (c) => {
    const s = seam();
    if (!s) return c.json({ error: "oauth login not configured" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as {
      account?: unknown;
      priority?: unknown;
      schedulable?: unknown;
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
    try {
      await s.setAccountSchedule({
        providerId: c.req.param("provider"),
        account,
        priority,
        schedulable,
      });
      // Rebuild so the new priority / schedulable reorders (or parks) this account now.
      if (!(await afterMutation())) return c.json(notApplied, 503);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
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
}
