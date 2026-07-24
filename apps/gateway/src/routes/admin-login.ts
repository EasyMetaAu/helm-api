import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  ADMIN_SESSION_COOKIE,
  type AdminAuthConfig,
  createAdminSessionToken,
  verifyAdminCredentials,
  verifyAdminSessionToken,
} from "../middleware/basic-auth.js";

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LoginSchema = z.object({
  username: z.string().max(128),
  password: z.string().max(512),
  next: z.string().max(2048).optional(),
});

export interface AdminLoginOptions {
  now?: () => number;
}

function safeNext(value: string | undefined): string {
  if (!value || !/^\/admin(?:[/?#]|$)/.test(value) || value.startsWith("//")) return "/admin";
  if (value.startsWith("/admin/login") || value.startsWith("/admin/logout")) return "/admin";
  return value;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

function sameOrigin(c: Context): boolean {
  if (c.req.header("Sec-Fetch-Site") === "same-origin") return true;
  const origin = c.req.header("Origin");
  if (origin === undefined) return true;
  if (origin === "null") return c.req.header("Sec-Fetch-Site") === "same-origin";

  try {
    const originHost = new URL(origin).host;
    const forwardedHost = c.req.header("X-Forwarded-Host")?.split(",")[0]?.trim();
    return [c.req.header("Host"), forwardedHost, new URL(c.req.url).host]
      .filter((host): host is string => Boolean(host))
      .includes(originHost);
  } catch {
    return false;
  }
}

function secureRequest(c: Context): boolean {
  const forwarded = c.req.header("X-Forwarded-Proto")?.split(",")[0]?.trim();
  return new URL(c.req.url).protocol === "https:" || forwarded === "https";
}

function setSessionCookie(c: Context, value: string, maxAge: number): void {
  setCookie(c, ADMIN_SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/admin",
    secure: secureRequest(c),
    maxAge,
  });
}

function loginPage(
  c: Context,
  values: { next: string; username?: string; error?: string; configured: boolean },
  status = 200,
): Response {
  const nonce = randomBytes(18).toString("base64");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  const message = values.configured
    ? values.error
    : "Administrator credentials are not configured. Restart Helm through the setup flow.";
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Sign in · Helm</title><style nonce="${nonce}">
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0f172a}body{min-height:100vh;background:#f8fafc;display:grid;place-items:center;padding:32px 20px;position:relative;overflow:hidden}body:before{content:"";position:fixed;inset:0;background:radial-gradient(circle at 18% 15%,rgba(79,70,229,.13),transparent 32%),radial-gradient(circle at 82% 80%,rgba(99,102,241,.09),transparent 34%),linear-gradient(rgba(148,163,184,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.12) 1px,transparent 1px);background-size:auto,auto,28px 28px,28px 28px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.72),transparent 84%);pointer-events:none}.shell{width:min(100%,420px);position:relative}.brand{display:flex;align-items:center;justify-content:center;gap:11px;margin-bottom:24px}.mark{width:38px;height:38px;border-radius:11px;background:#4f46e5;color:white;display:grid;place-items:center;box-shadow:0 10px 24px rgba(79,70,229,.25)}.brand-name{font-size:16px;font-weight:700;letter-spacing:-.02em}.brand-sub{font-size:12px;color:#64748b;margin-top:1px}.card{background:rgba(255,255,255,.96);border:1px solid #e2e8f0;border-radius:24px;padding:34px;box-shadow:0 28px 70px rgba(15,23,42,.12),0 2px 8px rgba(15,23,42,.05);backdrop-filter:blur(14px)}h1{font-size:29px;line-height:1.15;letter-spacing:-.035em;margin:0 0 10px}.lead{font-size:14px;line-height:1.6;color:#64748b;margin:0 0 28px}.field{display:grid;gap:7px;margin-bottom:17px}label{font-size:13px;font-weight:650;color:#334155}input{width:100%;min-height:46px;border:1px solid #cbd5e1;border-radius:11px;background:#fff;padding:0 13px;font:inherit;font-size:14px;color:#0f172a;outline:none;transition:border-color .15s,box-shadow .15s}input:hover{border-color:#94a3b8}input:focus{border-color:#6366f1;box-shadow:0 0 0 4px rgba(99,102,241,.14)}button{width:100%;min-height:47px;border:0;border-radius:11px;background:#111827;color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer;margin-top:5px;box-shadow:0 8px 18px rgba(15,23,42,.15);transition:transform .15s,background .15s,box-shadow .15s}button:hover{background:#1e293b;box-shadow:0 10px 24px rgba(15,23,42,.2);transform:translateY(-1px)}button:active{transform:none}button:focus-visible{outline:3px solid rgba(99,102,241,.35);outline-offset:2px}button:disabled{cursor:wait;opacity:.72;transform:none}.alert{border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:11px;padding:11px 12px;font-size:13px;line-height:1.45;margin:0 0 17px}.privacy{display:flex;align-items:flex-start;gap:8px;margin:22px 1px 0;color:#64748b;font-size:12px;line-height:1.5}.privacy svg{width:16px;height:16px;flex:none;margin-top:1px;color:#4f46e5}.footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:18px}@media(max-width:480px){body{padding:20px 14px}.card{padding:27px 22px;border-radius:20px}h1{font-size:26px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main class="shell"><div class="brand"><span class="mark" aria-hidden="true"><svg viewBox="0 0 64 64" width="23" height="23" fill="none"><g fill="currentColor"><rect x="15" y="16" width="7" height="32" rx="3.5"/><rect x="42" y="16" width="7" height="32" rx="3.5"/></g><path d="M22 32H38M34 27l6 5-6 5" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><div class="brand-name">Helm</div><div class="brand-sub">LLM Gateway</div></span></div><section class="card" aria-labelledby="login-title"><h1 id="login-title">Sign in to Helm</h1><p class="lead">Access your routing dashboard, providers, keys, and system settings.</p>${message ? `<div class="alert" role="alert">${escapeHtml(message)}</div>` : ""}<form method="post" action="/admin/login"><input type="hidden" name="next" value="${escapeHtml(values.next)}"><div class="field"><label for="username">Username</label><input id="username" name="username" value="${escapeHtml(values.username ?? "")}" autocomplete="username" maxlength="128" autofocus required></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="512" required></div><button type="submit"${values.configured ? "" : " disabled"}>Sign in</button></form><p class="privacy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3.75 5.25 6v5.25c0 4.45 2.84 7.95 6.75 9 3.91-1.05 6.75-4.55 6.75-9V6L12 3.75Z"/><path d="m9.5 12 1.65 1.65L14.75 10"/></svg><span>Your credentials stay on this Helm instance and are sent only to this origin.</span></p></section><p class="footer">Self-hosted control plane</p></main></body></html>`,
    status as 200 | 401,
  );
}

export function mountAdminLogin(auth: AdminAuthConfig, options: AdminLoginOptions = {}): Hono {
  const admin = new Hono();
  const now = options.now ?? Date.now;

  admin.get("/login", (c) => {
    const next = safeNext(c.req.query("next"));
    const token = getCookie(c, ADMIN_SESSION_COOKIE) ?? "";
    if (verifyAdminSessionToken(auth, token, now())) return c.redirect(next, 302);
    return loginPage(c, {
      next,
      configured: auth.username !== null && auth.password !== null,
    });
  });

  admin.post("/login", async (c) => {
    if (!sameOrigin(c)) return c.text("Forbidden", 403);
    const raw = await c.req.parseBody().catch(() => null);
    const parsed = LoginSchema.safeParse(raw);
    const next = safeNext(parsed.success ? parsed.data.next : undefined);
    if (
      !parsed.success ||
      !verifyAdminCredentials(auth, parsed.data.username, parsed.data.password)
    ) {
      return loginPage(
        c,
        {
          next,
          username: parsed.success ? parsed.data.username : "",
          error: "The username or password is incorrect.",
          configured: auth.username !== null && auth.password !== null,
        },
        401,
      );
    }
    const token = createAdminSessionToken(auth, now() + SESSION_SECONDS * 1000);
    setSessionCookie(c, token, SESSION_SECONDS);
    c.header("Cache-Control", "no-store");
    return c.redirect(next, 303);
  });

  admin.post("/logout", (c) => {
    if (!sameOrigin(c)) return c.text("Forbidden", 403);
    setSessionCookie(c, "", 0);
    c.header("Cache-Control", "no-store");
    return c.redirect("/admin/login", 303);
  });

  return admin;
}
