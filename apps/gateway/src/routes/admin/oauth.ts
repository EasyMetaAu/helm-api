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
      return c.json(
        await s.pollDeviceCode({
          sessionId: body.sessionId,
          account:
            typeof body.account === "string" && body.account ? body.account : DEFAULT_ACCOUNT,
        }),
      );
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
    return c.body(null, 204);
  });
}
