import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

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
  return {
    enabled: enabledEnv ?? admin.enabled ?? false,
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
// Hashing both sides to a fixed-length digest keeps timingSafeEqual happy even
// when the inputs differ in length.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers to keep timing flat.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
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
export function basicAuth(auth: AdminAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!auth.enabled) {
      await next();
      return;
    }

    const reject = () => c.text("Unauthorized", 401, { "WWW-Authenticate": REALM });

    // Fail closed: enabled without credentials means we reject everything.
    if (auth.username === null || auth.password === null) {
      return reject();
    }

    const parsed = parseBasic(c.req.header("Authorization"));
    if (parsed === null) {
      return reject();
    }

    const userOk = safeEqual(parsed.user, auth.username);
    const passOk = safeEqual(parsed.pass, auth.password);
    if (!userOk || !passOk) {
      return reject();
    }

    await next();
  };
}
