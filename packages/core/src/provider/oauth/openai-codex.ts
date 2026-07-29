// ChatGPT Plus/Pro (Codex Subscription) OAuth — authorization-code + PKCE, public
// client (no secret). Web manual-paste flow (begin/complete), mirroring Anthropic.
//
// PORTED from openclaw (MIT, © 2026 OpenClaw Foundation)
// extensions/openai/openai-chatgpt-oauth-flow.runtime.ts (+ auth-identity). Adapted
// to Helm's stateless web flow: NO localhost callback server — the admin UI hands
// back the pasted redirect URL. Codex exchanges authorization codes as form data,
// while refresh requests use JSON.
//
// ⚠️ ToS: reverse-engineered first-party Codex client; operator opts in (issue #38).

import {
  buildOAuthRequestSignal,
  generateOAuthState,
  generatePKCE,
  OAuthHttpError,
  parseOAuthAuthorizationInput,
  resolveOAuthTokenExpiresAt,
  throwIfOAuthLoginAborted,
} from "./runtime.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
  OpenAICodexIdentity,
} from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = "codex_cli_rs";
const WORKSPACE_PLAN_TYPES = new Set([
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "hc",
  "education",
  "edu",
]);

interface TokenResponseJson {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || !header || !payload || !signature) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return decoded !== null && typeof decoded === "object"
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseOpenAICodexIdentity(token: string): OpenAICodexIdentity {
  const payload = jwtPayload(token);
  if (!payload) return {};

  const profileValue = payload["https://api.openai.com/profile"];
  const profile =
    profileValue !== null && typeof profileValue === "object"
      ? (profileValue as Record<string, unknown>)
      : undefined;
  const authValue = payload["https://api.openai.com/auth"];
  const auth =
    authValue !== null && typeof authValue === "object"
      ? (authValue as Record<string, unknown>)
      : undefined;

  const email = nonEmptyString(payload.email) ?? nonEmptyString(profile?.email);
  const chatgptPlanType = nonEmptyString(auth?.chatgpt_plan_type);
  const chatgptUserId = nonEmptyString(auth?.chatgpt_user_id) ?? nonEmptyString(auth?.user_id);
  const accountId = nonEmptyString(auth?.chatgpt_account_id);

  return {
    ...(email ? { email } : {}),
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
    ...(chatgptUserId ? { chatgptUserId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(auth ? { isFedramp: auth.chatgpt_account_is_fedramp === true } : {}),
  };
}

export function isOpenAICodexWorkspacePlan(planType: string | undefined): boolean {
  return planType !== undefined && WORKSPACE_PLAN_TYPES.has(planType.toLowerCase());
}

export function openAICodexIdentityFingerprint(identity: OpenAICodexIdentity): string {
  return JSON.stringify([
    identity.accountId ?? null,
    identity.chatgptUserId ?? null,
    identity.chatgptPlanType === undefined
      ? null
      : isOpenAICodexWorkspacePlan(identity.chatgptPlanType),
    identity.email ?? null,
  ]);
}

export class OpenAICodexIdentityMismatchError extends Error {
  constructor() {
    super("OpenAI Codex OAuth identity changed during refresh; reconnect the account");
    this.name = "OpenAICodexIdentityMismatchError";
  }
}

function assertStableRefreshIdentity(
  previous: OAuthCredentials | undefined,
  next: OpenAICodexIdentity,
): void {
  if (!previous) return;
  if (
    previous.accountId !== undefined &&
    next.accountId !== undefined &&
    previous.accountId !== next.accountId
  ) {
    throw new OpenAICodexIdentityMismatchError();
  }
  if (
    previous.chatgptUserId !== undefined &&
    next.chatgptUserId !== undefined &&
    previous.chatgptUserId !== next.chatgptUserId
  ) {
    throw new OpenAICodexIdentityMismatchError();
  }
  if (
    previous.chatgptPlanType !== undefined &&
    next.chatgptPlanType !== undefined &&
    isOpenAICodexWorkspacePlan(previous.chatgptPlanType) !==
      isOpenAICodexWorkspacePlan(next.chatgptPlanType)
  ) {
    throw new OpenAICodexIdentityMismatchError();
  }
}

async function postToken(
  body: string,
  contentType: string,
  signal?: AbortSignal,
  // Drop-in fetch (e.g. the account's egress-proxy fetch). Defaults to the global
  // so the token exchange / refresh tunnels through the same hop as execution and
  // the bind-time call never leaks the operator's real IP (issue #38).
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<TokenResponseJson> {
  throwIfOAuthLoginAborted(signal);
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    signal: buildOAuthRequestSignal({ signal, timeoutMs: 30_000 }),
  });
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new OAuthHttpError("OpenAI Codex", res.status);
  }
  return (await res.json()) as TokenResponseJson;
}

function postTokenForm(
  body: URLSearchParams,
  signal?: AbortSignal,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<TokenResponseJson> {
  return postToken(body.toString(), "application/x-www-form-urlencoded", signal, fetchImpl);
}

function postTokenJson(
  body: Record<string, string>,
  signal?: AbortSignal,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<TokenResponseJson> {
  return postToken(JSON.stringify(body), "application/json", signal, fetchImpl);
}

function toCredentials(json: TokenResponseJson, previous?: OAuthCredentials): OAuthCredentials {
  const expires = resolveOAuthTokenExpiresAt(json.expires_in);
  const access = nonEmptyString(json.access_token);
  const refresh = nonEmptyString(json.refresh_token) ?? previous?.refresh;
  if (!access || !refresh || expires === undefined) {
    throw new Error("OpenAI Codex token response missing required fields");
  }

  const {
    access: _access,
    refresh: _refresh,
    expires: _expires,
    idToken: _idToken,
    ...previousExtra
  } = previous ?? { access: "", refresh: "", expires: 0 };
  const idToken = nonEmptyString(json.id_token);
  const accessIdentity = parseOpenAICodexIdentity(access);
  const idTokenIdentity = idToken ? parseOpenAICodexIdentity(idToken) : {};
  const nextIdentity = { ...accessIdentity, ...idTokenIdentity };
  assertStableRefreshIdentity(previous, nextIdentity);

  return {
    ...previousExtra,
    access,
    refresh,
    expires,
    ...nextIdentity,
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

export async function completeOpenAICodexLogin(
  input: {
    redirectInput: string;
    verifier: string;
    state: string;
  },
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<OAuthCredentials> {
  const parsed = parseOAuthAuthorizationInput(input.redirectInput);
  if (!parsed.code) throw new Error("Missing authorization code");
  if (parsed.state !== input.state) throw new Error("OAuth state mismatch");
  const json = await postTokenForm(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: parsed.code,
      code_verifier: input.verifier,
      redirect_uri: REDIRECT_URI,
    }),
    undefined,
    fetchImpl,
  );
  return toCredentials(json);
}

// Non-interactive refresh (public client: client_id + refresh_token, no secret).
export async function refreshOpenAICodexToken(
  credentials: OAuthCredentials | string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<OAuthCredentials> {
  const previous: OAuthCredentials =
    typeof credentials === "string"
      ? { access: "", refresh: credentials, expires: 0 }
      : credentials;
  const json = await postTokenJson(
    {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: previous.refresh,
    },
    undefined,
    fetchImpl,
  );
  return toCredentials(json, previous);
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
  refreshToken: (creds, fetchImpl) => refreshOpenAICodexToken(creds, fetchImpl),
  getApiKey: (creds) => creds.access,
};
