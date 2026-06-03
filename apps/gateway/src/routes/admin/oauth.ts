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
      if (typeof body.priority !== "number" || !Number.isInteger(body.priority)) {
        return c.json({ error: "priority must be an integer" }, 400);
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
