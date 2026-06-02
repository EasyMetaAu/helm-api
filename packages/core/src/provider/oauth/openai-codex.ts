// ChatGPT Plus/Pro (Codex Subscription) OAuth — authorization-code + PKCE, public
// client (no secret). Web manual-paste flow (begin/complete), mirroring Anthropic.
//
// PORTED from openclaw (MIT, © 2026 OpenClaw Foundation)
// extensions/openai/openai-chatgpt-oauth-flow.runtime.ts (+ auth-identity). Adapted
// to Helm's stateless web flow: NO localhost callback server — the admin UI hands
// back the pasted redirect URL. Token requests are form-encoded (the OpenAI auth
// endpoint differs from Anthropic's JSON token endpoint).
//
// ⚠️ ToS: reverse-engineered first-party Codex client; operator opts in (issue #38).

import {
  buildOAuthRequestSignal,
  generateOAuthState,
  generatePKCE,
  parseOAuthAuthorizationInput,
  resolveOAuthTokenExpiresAt,
  throwIfOAuthLoginAborted,
} from "./runtime.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "helm";

interface TokenResponseJson {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

// Decode the chatgpt_account_id from the access-token JWT payload. Required at
// execution time (the Codex Responses endpoint keys on the account); we capture it
// at login so it rides in the stored credential meta.
function accountIdFromToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  const payloadSeg = parts[1];
  if (parts.length !== 3 || !payloadSeg) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(payloadSeg, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

async function postTokenForm(
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<TokenResponseJson> {
  throwIfOAuthLoginAborted(signal);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: buildOAuthRequestSignal({ signal, timeoutMs: 30_000 }),
  });
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new Error(`OpenAI Codex OAuth HTTP ${res.status}`);
  }
  return (await res.json()) as TokenResponseJson;
}

function toCredentials(json: TokenResponseJson): OAuthCredentials {
  const expires = resolveOAuthTokenExpiresAt(json.expires_in, { refreshSkewMs: 5 * 60 * 1000 });
  if (!json.access_token || !json.refresh_token || expires === undefined) {
    throw new Error("OpenAI Codex token response missing required fields");
  }
  const accountId = accountIdFromToken(json.access_token);
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

// ── stateless two-step login (admin WEB UI; manual-paste) ─────────────────────
export interface CodexLoginStart {
  authorizeUrl: string;
  verifier: string;
  state: string;
}

export function beginOpenAICodexLogin(): CodexLoginStart {
  const { verifier, challenge } = generatePKCE();
  const state = generateOAuthState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", ORIGINATOR);
  return { authorizeUrl: url.toString(), verifier, state };
}

export async function completeOpenAICodexLogin(input: {
  redirectInput: string;
  verifier: string;
  state: string;
}): Promise<OAuthCredentials> {
  const parsed = parseOAuthAuthorizationInput(input.redirectInput);
  if (!parsed.code) throw new Error("Missing authorization code");
  if (parsed.state && parsed.state !== input.state) throw new Error("OAuth state mismatch");
  const json = await postTokenForm(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: parsed.code,
      code_verifier: input.verifier,
      redirect_uri: REDIRECT_URI,
    }),
  );
  return toCredentials(json);
}

// Non-interactive refresh (public client: client_id + refresh_token, no secret).
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
  const json = await postTokenForm(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  );
  // A refresh may omit refresh_token (rotation off); keep the prior one if so.
  if (!json.refresh_token) json.refresh_token = refreshToken;
  return toCredentials(json);
}

export const openaiCodexOAuthProvider: OAuthProviderInterface = {
  id: "openai-codex",
  name: "ChatGPT Plus/Pro (Codex)",
  usesCallbackServer: true,
  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    // Web/manual-paste login: show the authorize URL, then exchange the pasted code.
    const start = beginOpenAICodexLogin();
    callbacks.onAuth({
      url: start.authorizeUrl,
      instructions: "Complete login, then paste the redirect URL.",
    });
    const redirectInput = callbacks.onManualCodeInput
      ? await callbacks.onManualCodeInput()
      : await callbacks.onPrompt({ message: "Paste the authorization code or full redirect URL:" });
    return completeOpenAICodexLogin({
      redirectInput,
      verifier: start.verifier,
      state: start.state,
    });
  },
  refreshToken: (creds) => refreshOpenAICodexToken(creds.refresh),
  getApiKey: (creds) => creds.access,
};
