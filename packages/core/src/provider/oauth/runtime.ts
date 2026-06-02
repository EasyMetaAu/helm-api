// OAuth flow primitives (PKCE, state, redirect-input parsing, expiry math, abort
// helpers, success/error HTML). Framework-agnostic (principle 1).
//
// PORTED from openclaw (MIT, © 2026 OpenClaw Foundation)
// src/plugin-sdk/provider-oauth-runtime.ts. The openclaw `number-coercion`
// dependency is inlined below so this kit pulls in NOTHING from openclaw.

import { createHash, randomBytes } from "node:crypto";
import type { OAuthAuthorizationInput } from "./types.js";

// ── number coercion (inlined; finite-number guards only) ─────────────────────
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function positiveSecondsToSafeMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value * 1000), MAX_SAFE);
}

export function nonNegativeSecondsToSafeMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value * 1000), MAX_SAFE);
}

// Clamp a timeout to a safe positive timer value, falling back when invalid.
export function resolveTimerTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), MAX_SAFE);
}

// `expires_in` (seconds) → absolute ms-epoch expiry, minus a refresh-skew buffer.
export function resolveExpiresAtMsFromDurationSeconds(
  value: unknown,
  options: { nowMs?: number; bufferMs?: number } = {},
): number | undefined {
  const durationMs = positiveSecondsToSafeMs(value);
  if (durationMs === undefined) return undefined;
  const now = options.nowMs ?? Date.now();
  return now + durationMs - (options.bufferMs ?? 0);
}

// `expires_at` (absolute epoch seconds) → ms-epoch, minus a refresh-skew buffer.
export function resolveExpiresAtMsFromEpochSeconds(
  value: unknown,
  options: { bufferMs?: number } = {},
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value * 1000) - (options.bufferMs ?? 0);
}

// Public name kept for parity with the openclaw call sites (anthropic flow).
export function resolveOAuthTokenExpiresAt(
  value: unknown,
  options: { nowMs?: number; refreshSkewMs?: number } = {},
): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(value, {
    nowMs: options.nowMs,
    bufferMs: options.refreshSkewMs,
  });
}

// ── PKCE + state ─────────────────────────────────────────────────────────────
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// PKCE verifier (random 32 bytes) + S256 challenge (base64url(sha256(verifier))).
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// Opaque anti-CSRF state token.
export function generateOAuthState(): string {
  return base64url(randomBytes(32));
}

// ── redirect-input parsing ───────────────────────────────────────────────────
// Accepts a full redirect URL, a "code#state" pair, a raw query string, or a bare
// pasted code. Used for the manual-paste fallback (remote/no-browser hosts).
export function parseOAuthAuthorizationInput(input: string): OAuthAuthorizationInput {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL — fall through
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

// ── abort helpers ────────────────────────────────────────────────────────────
export function createOAuthLoginCancelledError(): Error {
  return new Error("Login cancelled");
}

export function throwIfOAuthLoginAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createOAuthLoginCancelledError();
}

// Race a promise against an abort signal; on abort, reject with the cancelled
// error and invoke `onAbort` (e.g. to stop a waiting callback server).
export function withOAuthLoginAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      onAbort?.();
      reject(createOAuthLoginCancelledError());
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e: unknown) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// A signal that aborts on the caller's signal OR a timeout (for token fetches).
export function buildOAuthRequestSignal(options: {
  signal?: AbortSignal;
  timeoutMs: number;
}): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(resolveTimerTimeoutMs(options.timeoutMs, 30_000));
  return options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
}

// ── success / error HTML for the callback page ───────────────────────────────
function escapeHtml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, message: string, details?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${escapeHtml(
    title,
  )}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#09090b;color:#fafafa;font-family:ui-sans-serif,system-ui,sans-serif;text-align:center}h1{font-size:24px;margin:0 0 10px}p{color:#a1a1aa;line-height:1.6}.d{margin-top:14px;font-family:ui-monospace,monospace;font-size:13px;color:#a1a1aa;word-break:break-word}</style></head><body><main><h1>${escapeHtml(
    title,
  )}</h1><p>${escapeHtml(message)}</p>${details ? `<div class="d">${escapeHtml(details)}</div>` : ""}</main></body></html>`;
}

export function oauthSuccessHtml(message: string): string {
  return page("Authentication successful", message);
}

export function oauthErrorHtml(message: string, details?: string): string {
  return page("Authentication failed", message, details);
}
