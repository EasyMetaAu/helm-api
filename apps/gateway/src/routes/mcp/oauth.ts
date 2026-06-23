import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { hashKey, type KeyStore } from "@helm/core";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app.js";
import { type AuthIdentity, authMiddleware } from "../../middleware/auth.js";

// docs/13 — OAuth 2.1 shim so ChatGPT's MCP connector can authenticate against
// /mcp. ChatGPT cannot present a raw API key; it runs an authorize-code + PKCE
// flow (RFC 9728 discovery → /authorize → /token). This module is a *thin*
// authorization server: the human pastes a helm API key on the /authorize login
// page, and the issued access token is a stateless HS256 JWT carrying that key's
// account. /mcp then accepts EITHER the JWT or a raw API key (back-compat).
//
// ponytail: stateless JWTs, no token/code store, no migration. The authorization
// code is itself a 60s-lived signed JWT (PKCE-bound). Ceiling: codes are
// replayable within their 60s window and access tokens are non-revocable until
// expiry — for a single-resource self-hosted gateway with TLS + PKCE that's an
// accepted trade. Upgrade path if it ever matters: a one-time-code store + a
// token denylist (then this whole file gains a store dep).

export interface McpOAuthDeps {
  keyStore: Pick<KeyStore, "getByHash">;
  /** HS256 key for signing codes + access tokens (deriveMcpSigningKey). */
  signingKey: Buffer;
  /** Access-token lifetime in seconds. */
  accessTtlSeconds: number;
  /** Public base URL override; else derived from forwarded headers. No trailing slash. */
  issuer?: string;
  /** Allowlisted redirect_uri prefixes (https). */
  allowedRedirectPrefixes: string[];
  now: () => number; // ms epoch (injectable for tests)
  log?: (line: string) => void;
}

// Domain-separated derivation from the at-rest OAuth key so we add NO new secret
// to the deployment: HELM_OAUTH_ENC_KEY already exists wherever subscription
// OAuth runs. Distinct label => unrelated to the AES key material.
export function deriveMcpSigningKey(encKey: Buffer): Buffer {
  return createHmac("sha256", encKey).update("helm-mcp-oauth/v1").digest();
}

// --- minimal HS256 JWT (no dep; we both issue and verify, so format is ours) ---

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj)));
}
function signJwt(payload: Record<string, unknown>, key: Buffer): string {
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(payload);
  const data = `${head}.${body}`;
  const sig = b64url(createHmac("sha256", key).update(data).digest());
  return `${data}.${sig}`;
}
function verifyJwt(token: string, key: Buffer, nowSec: number): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = b64url(createHmac("sha256", key).update(`${head}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp < nowSec) return null;
  return payload;
}

// PKCE S256: base64url(sha256(verifier)) === challenge (constant-time).
function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = b64url(createHash("sha256").update(verifier).digest());
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- request helpers ---

function baseUrl(
  c: { req: { url: string; header: (n: string) => string | undefined } },
  deps: McpOAuthDeps,
): string {
  if (deps.issuer) return deps.issuer.replace(/\/$/, "");
  const fwdProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const fwdHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const u = new URL(c.req.url);
  const proto = fwdProto ?? u.protocol.replace(":", "");
  const host = fwdHost ?? c.req.header("host") ?? u.host;
  return `${proto}://${host}`;
}

const AUTHZ_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

type AuthzParams = Partial<Record<(typeof AUTHZ_PARAMS)[number], string>>;

function pickParams(src: Record<string, unknown>): AuthzParams {
  const out: AuthzParams = {};
  for (const k of AUTHZ_PARAMS) {
    const v = src[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

function validateAuthz(
  q: AuthzParams,
  prefixes: string[],
): { ok: true } | { ok: false; error: string } {
  if (q.response_type && q.response_type !== "code")
    return { ok: false, error: "unsupported response_type (only 'code')" };
  const ru = q.redirect_uri;
  if (!ru) return { ok: false, error: "missing redirect_uri" };
  let u: URL;
  try {
    u = new URL(ru);
  } catch {
    return { ok: false, error: "invalid redirect_uri" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "redirect_uri must be https" };
  if (!prefixes.some((p) => ru.startsWith(p)))
    return { ok: false, error: "redirect_uri not in allowlist" };
  if (!q.code_challenge) return { ok: false, error: "missing code_challenge (PKCE required)" };
  if (q.code_challenge_method && q.code_challenge_method !== "S256")
    return { ok: false, error: "code_challenge_method must be S256" };
  return { ok: true };
}

// Escape for HTML attribute context — authorize params are attacker-controllable
// and reflected into hidden inputs, so this is the XSS boundary (not optional).
function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loginForm(q: AuthzParams, base: string, error?: string): string {
  const hidden = AUTHZ_PARAMS.filter((k) => q[k] !== undefined)
    .map((k) => `<input type="hidden" name="${k}" value="${escAttr(q[k] as string)}">`)
    .join("\n      ");
  const err = error ? `<p class="err">${escAttr(error)}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Helm memory</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#111}
  h1{font-size:1.25rem} label{display:block;margin:.75rem 0 .25rem;font-weight:600}
  input[type=password]{width:100%;padding:.6rem;border:1px solid #bbb;border-radius:.4rem;box-sizing:border-box}
  button{margin-top:1rem;width:100%;padding:.6rem;border:0;border-radius:.4rem;background:#111;color:#fff;font-size:1rem;cursor:pointer}
  .err{color:#b00020;font-weight:600} .hint{color:#666;font-size:.85rem}
</style></head>
<body>
  <h1>Connect to Helm memory</h1>
  <p class="hint">Paste a Helm API key to authorize this app. The key grants access to that key's memory only.</p>
  ${err}
  <form method="post" action="${escAttr(base)}/authorize">
      ${hidden}
    <label for="api_key">Helm API key</label>
    <input id="api_key" name="api_key" type="password" autocomplete="off" autofocus placeholder="helm_live_...">
    <button type="submit">Authorize</button>
  </form>
</body></html>`;
}

function identityFromClaims(claims: Record<string, unknown>): AuthIdentity {
  const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
  const mode = claims.mode === "observe" || claims.mode === "inject" ? claims.mode : "off";
  return {
    keyId: str(claims.kid),
    keyPrefix: str(claims.pfx),
    accountId: str(claims.sub),
    orgId: null,
    userId: null,
    role: claims.role === "root" ? "root" : "user",
    caps: {
      allowedLanes: null,
      allowCustomModel: false,
      rateLimit: { rpm: null, tpm: null },
      concurrencyLimit: null,
      budget: {
        requests: null,
        tokens: null,
        spendUsd: null,
        windowSeconds: null,
        behavior: "degrade",
        degradeLane: null,
      },
      // The only caps /mcp actually reads — keep memory scope faithful to the key.
      memory: {
        mode,
        projectId: typeof claims.pid === "string" ? claims.pid : null,
        threadSource: "header",
      },
    },
  };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

// Register the OAuth endpoints (all UNAUTHENTICATED — they ARE the auth surface).
export function registerMcpOAuth(app: Hono<AppEnv>, deps: McpOAuthDeps): void {
  // RFC 9728 protected-resource metadata (bare + path-suffixed form some clients use).
  const protectedResource = (c: Context<AppEnv>) => {
    const base = baseUrl(c, deps);
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: [],
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  // RFC 8414 authorization-server metadata (bare + path-suffixed form).
  const authServerMeta = (c: Context<AppEnv>) => {
    const base = baseUrl(c, deps);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [],
    });
  };
  app.get("/.well-known/oauth-authorization-server", authServerMeta);
  app.get("/.well-known/oauth-authorization-server/mcp", authServerMeta);

  // GET /authorize — show the login form (after validating the request shape).
  app.get("/authorize", (c) => {
    const q = pickParams(c.req.query());
    const v = validateAuthz(q, deps.allowedRedirectPrefixes);
    if (!v.ok) return c.text(v.error, 400);
    return c.html(loginForm(q, baseUrl(c, deps)));
  });

  // POST /authorize — validate the pasted key, mint a code, redirect to the client.
  app.post("/authorize", async (c) => {
    const form = await c.req.parseBody();
    const q = pickParams(form as Record<string, unknown>);
    const v = validateAuthz(q, deps.allowedRedirectPrefixes);
    if (!v.ok) return c.text(v.error, 400);

    const apiKey = typeof form.api_key === "string" ? form.api_key : "";
    const base = baseUrl(c, deps);
    if (!apiKey) return c.html(loginForm(q, base, "Please paste your API key."), 400);

    const rec = await deps.keyStore.getByHash(hashKey(apiKey));
    if (rec === null || rec.disabled) {
      deps.log?.("authorize: invalid or disabled API key");
      return c.html(loginForm(q, base, "Invalid or disabled API key."), 401);
    }

    const nowSec = Math.floor(deps.now() / 1000);
    const code = signJwt(
      {
        typ: "mcp_code",
        sub: rec.account_id,
        kid: rec.key_id,
        pfx: rec.prefix,
        role: rec.role,
        pid: rec.memory_project_id,
        mode: rec.memory_mode,
        cc: q.code_challenge,
        ru: q.redirect_uri,
        aud: q.resource ?? `${base}/mcp`,
        exp: nowSec + 60,
      },
      deps.signingKey,
    );
    // q.redirect_uri is allowlisted + parseable (validateAuthz).
    const url = new URL(q.redirect_uri as string);
    url.searchParams.set("code", code);
    if (q.state) url.searchParams.set("state", q.state);
    return c.redirect(url.toString(), 302);
  });

  // POST /token — exchange code (+ PKCE verifier) for an access token.
  app.post("/token", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, unknown>;
    const grant = typeof form.grant_type === "string" ? form.grant_type : "";
    if (grant !== "authorization_code")
      return c.json({ error: "unsupported_grant_type" }, 400, NO_STORE);

    const code = typeof form.code === "string" ? form.code : "";
    const verifier = typeof form.code_verifier === "string" ? form.code_verifier : "";
    const redirectUri = typeof form.redirect_uri === "string" ? form.redirect_uri : "";
    const nowSec = Math.floor(deps.now() / 1000);

    const claims = verifyJwt(code, deps.signingKey, nowSec);
    if (!claims || claims.typ !== "mcp_code")
      return c.json(
        { error: "invalid_grant", error_description: "bad or expired authorization code" },
        400,
        NO_STORE,
      );
    if (!verifier || !pkceMatches(verifier, String(claims.cc)))
      return c.json(
        { error: "invalid_grant", error_description: "PKCE verification failed" },
        400,
        NO_STORE,
      );
    if (redirectUri && redirectUri !== claims.ru)
      return c.json(
        { error: "invalid_grant", error_description: "redirect_uri mismatch" },
        400,
        NO_STORE,
      );

    const access = signJwt(
      {
        typ: "mcp_access",
        sub: claims.sub,
        kid: claims.kid,
        pfx: claims.pfx,
        role: claims.role,
        pid: claims.pid,
        mode: claims.mode,
        aud: claims.aud,
        exp: nowSec + deps.accessTtlSeconds,
      },
      deps.signingKey,
    );
    return c.json(
      {
        access_token: access,
        token_type: "Bearer",
        expires_in: deps.accessTtlSeconds,
        scope: typeof form.scope === "string" ? form.scope : "",
      },
      200,
      NO_STORE,
    );
  });
}

// /mcp auth that accepts EITHER an issued access JWT or a raw API key. A bearer
// that is not a valid mcp_access token falls through to the existing API-key
// middleware (an API key IS a bearer), so both ChatGPT and direct clients work.
export function mcpAuth(deps: McpOAuthDeps): MiddlewareHandler {
  const apiKeyMw = authMiddleware({ keyStore: deps.keyStore, log: deps.log ?? (() => {}) });
  return async (c, next) => {
    const auth = c.req.header("Authorization");
    const m = auth ? /^Bearer\s+(.+)$/.exec(auth) : null;
    if (m?.[1]) {
      const claims = verifyJwt(m[1], deps.signingKey, Math.floor(deps.now() / 1000));
      if (claims && claims.typ === "mcp_access") {
        c.set("identity", identityFromClaims(claims));
        return next();
      }
    }
    return apiKeyMw(c, next);
  };
}
