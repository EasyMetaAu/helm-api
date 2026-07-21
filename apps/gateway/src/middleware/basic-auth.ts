import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

// Admin-UI authentication. This is DELIBERATELY separate from API-key auth
// (docs/06): different header (HTTP Basic vs. Bearer helm_...), different
// credential source (config/env vs. KeyStore), no RBAC. The admin path never
// consults the KeyStore and API traffic never consults these credentials.
export interface AdminAuthConfig {
  enabled: boolean;
  // Resolved credentials: env wins over config; null when unconfigured.
  username: string | null;
  password: string | null;
}

const REALM = 'Basic realm="Helm Admin"';
export const ADMIN_SESSION_COOKIE = "helm_admin_session";

export interface AdminAuthMiddlewareOptions {
  allowSession?: boolean;
  redirectToLogin?: boolean;
  now?: () => number;
}

// Parse a truthy env flag (1/true/yes/on, case-insensitive). Anything else
// (incl. undefined) is null so the caller can fall back to config.
function envFlag(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

// Resolve the effective admin credentials. Environment variables override
// config.admin.* (env-priority, docs/11) so container deployments can inject
// secrets — and toggle the admin surface on — without editing files (docs/10):
//   - HELM_ADMIN_ENABLED  overrides admin.enabled
//   - HELM_ADMIN_USER     overrides admin.username
//   - HELM_ADMIN_PASSWORD overrides admin.password
export function resolveAdminAuth(
  cfg: { admin?: { enabled?: boolean; username?: string; password?: string } },
  env: Record<string, string | undefined>,
): AdminAuthConfig {
  const admin = cfg.admin ?? {};
  const enabledEnv = envFlag(env.HELM_ADMIN_ENABLED);
  const username = env.HELM_ADMIN_USER ?? admin.username ?? null;
  const password = env.HELM_ADMIN_PASSWORD ?? admin.password ?? null;
  // SECURITY: configuring credentials AUTO-ENABLES the admin surface. Setting
  // HELM_ADMIN_USER/PASSWORD is the obvious "protect admin" action; the old default
  // (`?? false`) left admin (incl. /admin/api/keys) open whenever the separate
  // HELM_ADMIN_ENABLED flag was forgotten. Precedence: explicit env flag > explicit
  // config flag > "credentials present".
  const credsPresent = username !== null && password !== null;
  return {
    enabled: enabledEnv ?? admin.enabled ?? credsPresent,
    username,
    password,
  };
}

// Startup-time guard: if admin is enabled but credentials are missing, emit a
// single explicit warning so the operator is not unknowingly exposed. We do NOT
// throw (the gateway still boots), but runtime requests fail closed (see
// basicAuth). The password is never included in the log line.
export function warnIfAdminUnconfigured(auth: AdminAuthConfig, log: (line: string) => void): void {
  if (auth.enabled && (auth.username === null || auth.password === null)) {
    log(
      "WARN admin: admin UI is enabled but no username/password is configured; all admin requests will be rejected (401). Set HELM_ADMIN_USER/HELM_ADMIN_PASSWORD or config admin.* to avoid exposure.",
    );
  }
}

// Constant-time string comparison to avoid leaking length/content via timing.
// Both sides are reduced to a fixed-length sha256 digest first, so the inputs
// fed to timingSafeEqual are always equal-length (32 bytes) regardless of the
// raw credential lengths — no length branch, and timing does not vary with the
// attacker-supplied length. (Pre-hash collisions are infeasible for sha256.)
function safeEqual(a: string, b: string): boolean {
  const digA = createHash("sha256").update(a, "utf8").digest();
  const digB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digA, digB);
}

export function verifyAdminCredentials(
  auth: AdminAuthConfig,
  username: string,
  password: string,
): boolean {
  return (
    auth.username !== null &&
    auth.password !== null &&
    safeEqual(username, auth.username) &&
    safeEqual(password, auth.password)
  );
}

function adminSessionKey(auth: AdminAuthConfig): Buffer | null {
  if (auth.username === null || auth.password === null) return null;
  return createHash("sha256")
    .update("helm-admin-session\0", "utf8")
    .update(auth.username, "utf8")
    .update("\0", "utf8")
    .update(auth.password, "utf8")
    .digest();
}

export function createAdminSessionToken(auth: AdminAuthConfig, expiresAtMs: number): string {
  const key = adminSessionKey(auth);
  if (!key || !Number.isSafeInteger(expiresAtMs)) {
    throw new Error("admin credentials are required to create a session");
  }
  const payload = `v1.${expiresAtMs}`;
  const signature = createHmac("sha256", key).update(payload, "utf8").digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAdminSessionToken(
  auth: AdminAuthConfig,
  token: string,
  nowMs = Date.now(),
): boolean {
  const key = adminSessionKey(auth);
  if (!key) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAtMs = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return false;
  const providedText = parts[2];
  if (!providedText) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(providedText, "base64url");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key).update(`v1.${parts[1]}`, "utf8").digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// Parse `Authorization: Basic base64(user:pass)`. Returns null for any other
// scheme (e.g. Bearer) or malformed input.
function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/.exec(header);
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

// Hono middleware enforcing HTTP Basic auth for the admin surface.
// - enabled:false              -> pass through (admin disabled, nothing to guard)
// - enabled:true, creds missing -> fail closed: every request 401 (never silently allowed)
// - enabled:true, creds present -> validate Basic; mismatch -> 401 + WWW-Authenticate
// Credentials are compared in constant time and the password is never logged.
export function basicAuth(
  auth: AdminAuthConfig,
  options: AdminAuthMiddlewareOptions = {},
): MiddlewareHandler {
  return async (c, next) => {
    if (!auth.enabled) {
      await next();
      return;
    }

    const reject = () => {
      const authorization = c.req.header("Authorization");
      const acceptsHtml = c.req.header("Accept")?.includes("text/html") ?? false;
      const pageLikePath = !/\.[a-z0-9]+$/i.test(c.req.path);
      if (
        options.redirectToLogin &&
        authorization === undefined &&
        (acceptsHtml || pageLikePath) &&
        (c.req.method === "GET" || c.req.method === "HEAD")
      ) {
        const url = new URL(c.req.url);
        return c.redirect(
          `/admin/login?next=${encodeURIComponent(`${c.req.path}${url.search}`)}`,
          302,
        );
      }
      if (options.allowSession) return c.text("Unauthorized", 401);
      return c.text("Unauthorized", 401, { "WWW-Authenticate": REALM });
    };

    // Fail closed: enabled without credentials means we reject everything.
    if (auth.username === null || auth.password === null) {
      return reject();
    }

    const parsed = parseBasic(c.req.header("Authorization"));
    const basicOk = parsed !== null && verifyAdminCredentials(auth, parsed.user, parsed.pass);
    const sessionOk =
      options.allowSession === true &&
      verifyAdminSessionToken(
        auth,
        getCookie(c, ADMIN_SESSION_COOKIE) ?? "",
        options.now?.() ?? Date.now(),
      );
    if (!basicOk && !sessionOk) return reject();

    await next();
  };
}
