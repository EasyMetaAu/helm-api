// xAI/Grok subscription OAuth. The public xAI API-key product uses api.x.ai;
// SuperGrok/X Premium OAuth is a separate device-code flow discovered from
// auth.x.ai and executes through cli-chat-proxy.grok.com.
//
// Protocol behaviour adapted from OpenClaw (MIT, © 2026 OpenClaw Foundation),
// extensions/xai/xai-oauth.ts. Helm keeps only the provider-neutral OAuth pieces.

import {
  buildOAuthRequestSignal,
  OAuthHttpError,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromEpochSeconds,
  throwIfOAuthLoginAborted,
} from "./runtime.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_GROK_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
// First-party protocol version observed from the installed Grok CLI release.
// The subscription proxy rejects inference requests without this header (HTTP 426).
export const XAI_GROK_CLIENT_VERSION = "0.2.93";
export const XAI_GROK_CLIENT_VERSION_ENV = "HELM_XAI_GROK_CLIENT_VERSION";

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/**
 * Resolve the first-party protocol version advertised to the Grok CLI proxy.
 * The checked-in default tracks the Grok CLI release used by Helm's live smoke.
 * An operator may temporarily follow an upstream minimum-version bump without a
 * Helm rebuild; strict semver validation prevents header injection/fake labels.
 */
export function resolveXaiGrokClientVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[XAI_GROK_CLIENT_VERSION_ENV]?.trim();
  const version = configured || XAI_GROK_CLIENT_VERSION;
  if (version.length > 64 || !SEMVER_PATTERN.test(version)) {
    throw new Error(
      `${XAI_GROK_CLIENT_VERSION_ENV} must be a semantic version (for example 0.2.93)`,
    );
  }
  return version;
}

export function xaiGrokProtocolHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-version": resolveXaiGrokClientVersion(env),
  };
}

export function xaiGrokInferenceHeaders(
  wireModel: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const model = wireModel.trim();
  if (model.length === 0) throw new Error("xAI inference request is missing its wire model");
  if (model.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(model)) {
    throw new Error("xAI inference request has an invalid wire model");
  }
  return {
    ...xaiGrokProtocolHeaders(env),
    "x-grok-model-override": model,
  };
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_DEVICE_TTL_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const SLOW_DOWN_MS = 5_000;

interface XaiDiscovery {
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
}

export interface XaiDeviceStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  tokenEndpoint: string;
  intervalMs: number;
  expiresAt: number;
}

export type XaiDevicePollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "done"; credentials: OAuthCredentials };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isTrustedXaiOAuthEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"));
  } catch {
    return false;
  }
}

function trustedEndpoint(endpoint: unknown, label: string): string {
  if (typeof endpoint !== "string" || !isTrustedXaiOAuthEndpoint(endpoint)) {
    throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
  }
  return endpoint;
}

function xaiHeaders(contentType = false): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": "helm-api/xai-oauth",
    ...(contentType ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`xAI OAuth response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`xAI OAuth response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function discoverXaiOAuth(fetchImpl: typeof fetch): Promise<XaiDiscovery> {
  const response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
    headers: xaiHeaders(),
    redirect: "error",
    signal: buildOAuthRequestSignal({ timeoutMs: FETCH_TIMEOUT_MS }),
  });
  const body = record(await readJson(response));
  if (!response.ok) throw new OAuthHttpError("xAI discovery", response.status);
  return {
    tokenEndpoint: trustedEndpoint(body.token_endpoint, "token endpoint"),
    deviceAuthorizationEndpoint: trustedEndpoint(
      body.device_authorization_endpoint,
      "device authorization endpoint",
    ),
  };
}

function secondsToMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value * 1000), Number.MAX_SAFE_INTEGER)
    : fallback;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  const payload = token?.split(".")[1];
  if (!payload) return {};
  try {
    return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

function parseTokenResponse(
  body: unknown,
  tokenEndpoint: string,
  now: () => number,
  previousRefresh?: string,
): OAuthCredentials {
  const json = record(body);
  const access = nonEmptyString(json.access_token);
  const refresh = nonEmptyString(json.refresh_token) ?? previousRefresh;
  if (!access) throw new Error("xAI OAuth token response is missing access_token");
  if (!refresh) throw new Error("xAI OAuth token response is missing refresh_token");
  const idToken = nonEmptyString(json.id_token);
  const identity = decodeJwtPayload(idToken ?? access);
  const expires =
    resolveExpiresAtMsFromDurationSeconds(json.expires_in, { nowMs: now() }) ??
    resolveExpiresAtMsFromEpochSeconds(decodeJwtPayload(access).exp) ??
    now() + 60 * 60_000;
  const email = nonEmptyString(identity.email);
  const accountId = nonEmptyString(identity.sub);
  return {
    access,
    refresh,
    expires,
    tokenEndpoint,
    issuer: XAI_OAUTH_ISSUER,
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

export async function beginXaiDeviceLogin(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<XaiDeviceStart> {
  const discovery = await discoverXaiOAuth(fetchImpl);
  const response = await fetchImpl(discovery.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: xaiHeaders(true),
    body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
    redirect: "error",
    signal: buildOAuthRequestSignal({ timeoutMs: FETCH_TIMEOUT_MS }),
  });
  const body = record(await readJson(response));
  if (!response.ok) throw new OAuthHttpError("xAI device authorization", response.status);
  const deviceCode = nonEmptyString(body.device_code);
  const userCode = nonEmptyString(body.user_code);
  const verificationUri = trustedEndpoint(
    nonEmptyString(body.verification_uri_complete) ?? body.verification_uri,
    "device verification URI",
  );
  if (!deviceCode || !userCode) {
    throw new Error("xAI device code response is missing device_code or user_code");
  }
  const ttlMs = secondsToMs(body.expires_in, DEFAULT_DEVICE_TTL_MS);
  return {
    deviceCode,
    userCode,
    verificationUri,
    tokenEndpoint: discovery.tokenEndpoint,
    intervalMs: secondsToMs(body.interval, DEFAULT_POLL_INTERVAL_MS),
    expiresAt: now() + ttlMs,
  };
}

export async function pollXaiDeviceOnce(
  input: { tokenEndpoint: string; deviceCode: string },
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<XaiDevicePollResult> {
  const endpoint = trustedEndpoint(input.tokenEndpoint, "token endpoint");
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: xaiHeaders(true),
    body: new URLSearchParams({
      grant_type: DEVICE_GRANT,
      client_id: XAI_OAUTH_CLIENT_ID,
      device_code: input.deviceCode,
    }),
    redirect: "error",
    signal: buildOAuthRequestSignal({ timeoutMs: FETCH_TIMEOUT_MS }),
  });
  const body = record(await readJson(response));
  if (response.ok) {
    return { status: "done", credentials: parseTokenResponse(body, endpoint, now) };
  }
  if (body.error === "authorization_pending") return { status: "pending" };
  if (body.error === "slow_down") return { status: "slow_down" };
  if (body.error === "access_denied" || body.error === "authorization_denied") {
    throw new Error("xAI device authorization was denied");
  }
  if (body.error === "expired_token") throw new Error("xAI device code expired");
  throw new OAuthHttpError("xAI device token exchange", response.status);
}

export async function refreshXaiOAuthToken(
  credentials: OAuthCredentials,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<OAuthCredentials> {
  const savedEndpoint = nonEmptyString(credentials.tokenEndpoint);
  const tokenEndpoint = savedEndpoint
    ? trustedEndpoint(savedEndpoint, "token endpoint")
    : (await discoverXaiOAuth(fetchImpl)).tokenEndpoint;
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: xaiHeaders(true),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: credentials.refresh,
    }),
    redirect: "error",
    signal: buildOAuthRequestSignal({ timeoutMs: FETCH_TIMEOUT_MS }),
  });
  const body = await readJson(response);
  if (!response.ok) throw new OAuthHttpError("xAI refresh", response.status);
  return {
    ...credentials,
    ...parseTokenResponse(body, tokenEndpoint, now, credentials.refresh),
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const start = await beginXaiDeviceLogin();
  callbacks.onAuth({
    url: start.verificationUri,
    instructions: `Enter code: ${start.userCode}`,
  });
  let intervalMs = start.intervalMs;
  while (Date.now() < start.expiresAt) {
    throwIfOAuthLoginAborted(callbacks.signal);
    const remainingMs = start.expiresAt - Date.now();
    await wait(Math.min(Math.max(intervalMs, MIN_POLL_INTERVAL_MS), remainingMs), callbacks.signal);
    throwIfOAuthLoginAborted(callbacks.signal);
    if (Date.now() >= start.expiresAt) break;
    const result = await pollXaiDeviceOnce({
      tokenEndpoint: start.tokenEndpoint,
      deviceCode: start.deviceCode,
    });
    if (result.status === "done") return result.credentials;
    if (result.status === "slow_down") intervalMs += SLOW_DOWN_MS;
  }
  throw new Error("xAI device authorization timed out");
}

export const xaiOAuthProvider: OAuthProviderInterface = {
  id: "xai",
  name: "xAI (Grok SuperGrok/X Premium)",
  usesCallbackServer: false,
  login: loginXai,
  refreshToken: (credentials, fetchImpl) => refreshXaiOAuthToken(credentials, fetchImpl),
  getApiKey: (credentials) => credentials.access,
};
