// Anthropic OAuth (Claude Pro/Max) — authorization-code + PKCE with a localhost
// callback server and a manual paste-the-redirect-URL fallback.
//
// PORTED from openclaw (MIT, © 2026 OpenClaw Foundation)
// src/llm/utils/oauth/anthropic.ts. CLI-only (uses node:http for the callback);
// the refresh grant is a PUBLIC PKCE client — client_id + refresh_token, NO
// client_secret.
//
// ⚠️ ToS: these are reverse-engineered first-party client constants. Using a
// Claude subscription via a third-party gateway may violate Anthropic's terms;
// the operator opts in (see README disclaimer, issue #38).

import { createServer, type Server } from "node:http";
import {
  buildOAuthRequestSignal,
  generateOAuthState,
  generatePKCE,
  oauthErrorHtml,
  oauthSuccessHtml,
  parseOAuthAuthorizationInput,
  resolveOAuthTokenExpiresAt,
  throwIfOAuthLoginAborted,
  withOAuthLoginAbort,
} from "./runtime.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const decode = (s: string) => Buffer.from(s, "base64").toString("utf8");
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = process.env.HELM_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface CallbackServer {
  server: Server;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string; state: string } | null>;
}

function parseTokenCredentials(responseBody: string): OAuthCredentials {
  let data: unknown;
  try {
    data = JSON.parse(responseBody);
  } catch {
    throw new Error("Anthropic token response was not valid JSON");
  }
  const rec = (data ?? {}) as Record<string, unknown>;
  const expires = resolveOAuthTokenExpiresAt(rec.expires_in, { refreshSkewMs: REFRESH_SKEW_MS });
  if (
    typeof rec.access_token !== "string" ||
    !rec.access_token ||
    typeof rec.refresh_token !== "string" ||
    !rec.refresh_token ||
    expires === undefined
  ) {
    throw new Error("Anthropic token response missing required fields");
  }
  return { access: rec.access_token, refresh: rec.refresh_token, expires };
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settle: ((v: { code: string; state: string } | null) => void) | undefined;
    let settled = false;
    const waitForCode = new Promise<{ code: string; state: string } | null>((res) => {
      settle = (v) => {
        if (settled) return;
        settled = true;
        res(v);
      };
    });

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Callback route not found."));
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
          return;
        }
        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Missing code or state parameter."));
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("State mismatch."));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
        settle?.({ code, state });
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
      }
    });
    server.on("error", reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        server,
        cancelWait: () => settle?.(null),
        waitForCode: () => waitForCode,
      });
    });
  });
}

async function postJson(
  url: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  throwIfOAuthLoginAborted(signal);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: buildOAuthRequestSignal({ signal, timeoutMs: 30_000 }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the body — an OAuth error body can carry credential material.
    throw new Error(`Anthropic OAuth HTTP ${res.status}`);
  }
  return text;
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const body = await postJson(
    TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
    signal,
  );
  return parseTokenCredentials(body);
}

// Interactive login: open the authorize URL, wait for the localhost callback, and
// fall back to a pasted redirect URL / code if the browser is on another machine.
export async function loginAnthropic(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  throwIfOAuthLoginAborted(callbacks.signal);
  const { verifier, challenge } = generatePKCE();
  const expectedState = generateOAuthState();
  const cb = await startCallbackServer(expectedState);

  try {
    const authParams = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: expectedState,
    });
    callbacks.onAuth({
      url: `${AUTHORIZE_URL}?${authParams.toString()}`,
      instructions:
        "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
    });

    let code: string | undefined;
    let state: string | undefined;

    // Race the localhost callback against an optional manual paste.
    if (callbacks.onManualCodeInput) {
      const manual = callbacks
        .onManualCodeInput()
        .then((input) => {
          cb.cancelWait();
          return input;
        })
        .catch(() => undefined);
      const viaCallback = await withOAuthLoginAbort(
        cb.waitForCode(),
        callbacks.signal,
        cb.cancelWait,
      );
      if (viaCallback?.code) {
        code = viaCallback.code;
        state = viaCallback.state;
      } else {
        const input = await manual;
        if (input) {
          const parsed = parseOAuthAuthorizationInput(input);
          if (parsed.state && parsed.state !== expectedState)
            throw new Error("OAuth state mismatch");
          code = parsed.code;
          state = parsed.state ?? expectedState;
        }
      }
    } else {
      const viaCallback = await withOAuthLoginAbort(
        cb.waitForCode(),
        callbacks.signal,
        cb.cancelWait,
      );
      if (viaCallback?.code) {
        code = viaCallback.code;
        state = viaCallback.state;
      }
    }

    // Last resort: prompt for a pasted code/URL.
    if (!code) {
      const input = await withOAuthLoginAbort(
        callbacks.onPrompt({
          message: "Paste the authorization code or full redirect URL:",
          placeholder: REDIRECT_URI,
        }),
        callbacks.signal,
        cb.cancelWait,
      );
      const parsed = parseOAuthAuthorizationInput(input);
      if (parsed.state && parsed.state !== expectedState) throw new Error("OAuth state mismatch");
      code = parsed.code;
      state = parsed.state ?? expectedState;
    }

    if (!code) throw new Error("Missing authorization code");
    callbacks.onProgress?.("Exchanging authorization code for tokens...");
    return await exchangeAuthorizationCode(
      code,
      state ?? expectedState,
      verifier,
      callbacks.signal,
    );
  } finally {
    cb.server.close();
  }
}

// ── stateless two-step login (for the admin WEB UI; no callback server) ───────
// The web flow can't host the hardcoded localhost:53692 redirect, so it is a
// manual-paste exchange: begin -> show authorizeUrl -> user logs in -> pastes the
// final redirect URL/code -> complete. The PKCE `verifier` + `state` are returned
// by begin and MUST be held server-side (ephemeral) and handed back to complete.
export interface AnthropicLoginStart {
  authorizeUrl: string;
  verifier: string;
  state: string;
}

export function beginAnthropicLogin(): AnthropicLoginStart {
  const { verifier, challenge } = generatePKCE();
  const state = generateOAuthState();
  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { authorizeUrl: `${AUTHORIZE_URL}?${authParams.toString()}`, verifier, state };
}

export async function completeAnthropicLogin(input: {
  redirectInput: string;
  verifier: string;
  state: string;
}): Promise<OAuthCredentials> {
  const parsed = parseOAuthAuthorizationInput(input.redirectInput);
  if (!parsed.code) throw new Error("Missing authorization code");
  if (parsed.state && parsed.state !== input.state) throw new Error("OAuth state mismatch");
  return exchangeAuthorizationCode(parsed.code, parsed.state ?? input.state, input.verifier);
}

// Non-interactive refresh (public PKCE client: client_id + refresh_token, no secret).
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  const body = await postJson(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  return parseTokenCredentials(body);
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
  id: "anthropic",
  name: "Anthropic (Claude Pro/Max)",
  usesCallbackServer: true,
  login: loginAnthropic,
  refreshToken: (creds) => refreshAnthropicToken(creds.refresh),
  getApiKey: (creds) => creds.access,
};
