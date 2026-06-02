// GitHub Copilot OAuth — device-code flow + Copilot token exchange.
//
// PORTED from openclaw (MIT, © 2026 OpenClaw Foundation)
// src/llm/utils/oauth/github-copilot.ts. Two-level token model: the stored
// `refresh` is the long-lived GitHub OAuth token; `access` is a SHORT-lived
// Copilot token minted from it (GET copilot_internal/v2/token). The Copilot token
// embeds `proxy-ep=...` which determines the chat API base URL, and mandatory
// editor headers (COPILOT_HEADERS) ride on every chat call.
//
// ⚠️ ToS: reverse-engineered first-party client; operator opts in (issue #38).

import {
  nonNegativeSecondsToSafeMs,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromEpochSeconds,
} from "./runtime.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };

const decode = (s: string) => Buffer.from(s, "base64").toString("utf8");
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

// Mandatory editor identity headers — the Copilot backend rejects requests
// without them. Exported for the executor wiring (Phase 6).
export const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

const REQUEST_TIMEOUT_MS = 30_000;
const EPOCH_SKEW_MS = 5 * 60 * 1000;

export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

// proxy-ep=proxy.individual.githubcopilot.com → https://api.individual.githubcopilot.com
function getBaseUrlFromToken(token: string): string | null {
  const proxyHost = token.match(/proxy-ep=([^;]+)/)?.[1];
  if (!proxyHost) return null;
  return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
}

export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  if (token) {
    const fromToken = getBaseUrlFromToken(token);
    if (fromToken) return fromToken;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return "https://api.individual.githubcopilot.com";
}

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new Error(`GitHub Copilot HTTP ${res.status}`);
  }
  return res.json();
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  intervalMs: number;
  expiresAt: number;
}

async function startDeviceFlow(domain: string, signal?: AbortSignal): Promise<DeviceCode> {
  const data = (await fetchJson(
    getUrls(domain).deviceCodeUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": COPILOT_HEADERS["User-Agent"],
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }),
    },
    signal,
  )) as Record<string, unknown>;

  const intervalMs = nonNegativeSecondsToSafeMs(data.interval);
  const expiresAt = resolveExpiresAtMsFromDurationSeconds(data.expires_in);
  if (
    typeof data.device_code !== "string" ||
    typeof data.user_code !== "string" ||
    typeof data.verification_uri !== "string" ||
    intervalMs === undefined ||
    expiresAt === undefined
  ) {
    throw new Error("Invalid device code response");
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    intervalMs,
    expiresAt,
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

async function pollForGitHubAccessToken(
  domain: string,
  deviceCode: string,
  intervalMs: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  const url = getUrls(domain).accessTokenUrl;
  let waitMs = Math.max(1000, intervalMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    await abortableSleep(Math.min(waitMs, deadline - Date.now()), signal);
    const raw = (await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": COPILOT_HEADERS["User-Agent"],
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
      signal,
    )) as Record<string, unknown>;

    if (typeof raw.access_token === "string") return raw.access_token;
    if (raw.error === "authorization_pending") continue;
    if (raw.error === "slow_down") {
      waitMs = Math.max(1000, waitMs + 5000);
      continue;
    }
    if (typeof raw.error === "string") throw new Error(`Device flow failed: ${raw.error}`);
  }
  throw new Error("Device flow timed out");
}

// ── stateless device-code login (for the admin WEB UI) ────────────────────────
// begin -> show {userCode, verificationUri} -> the UI polls pollCopilotDeviceOnce
// until status "done" -> mint the Copilot token via refreshGitHubCopilotToken.
// The session state (deviceCode, domain, expiresAt) is held server-side between
// calls. This avoids a long-lived blocking request (unlike the CLI poll loop).
export interface CopilotDeviceStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  domain: string;
  enterpriseDomain?: string;
}

export async function beginCopilotDeviceLogin(
  enterpriseInput?: string,
): Promise<CopilotDeviceStart> {
  const trimmed = (enterpriseInput ?? "").trim();
  const enterpriseDomain = trimmed ? normalizeDomain(trimmed) : null;
  if (trimmed && !enterpriseDomain) throw new Error("Invalid GitHub Enterprise URL/domain");
  const domain = enterpriseDomain || "github.com";
  const device = await startDeviceFlow(domain);
  return {
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    deviceCode: device.device_code,
    intervalMs: device.intervalMs,
    expiresAt: device.expiresAt,
    domain,
    enterpriseDomain: enterpriseDomain ?? undefined,
  };
}

export type CopilotPollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "done"; githubToken: string };

// One device-token poll. The UI calls this on an interval; it never blocks for the
// whole flow. "done" hands back the GitHub token to exchange for a Copilot token.
export async function pollCopilotDeviceOnce(input: {
  domain: string;
  deviceCode: string;
}): Promise<CopilotPollResult> {
  const raw = (await fetchJson(getUrls(input.domain).accessTokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": COPILOT_HEADERS["User-Agent"],
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  })) as Record<string, unknown>;

  if (typeof raw.access_token === "string")
    return { status: "done", githubToken: raw.access_token };
  if (raw.error === "authorization_pending") return { status: "pending" };
  if (raw.error === "slow_down") return { status: "slow_down" };
  throw new Error(`Device flow failed: ${typeof raw.error === "string" ? raw.error : "unknown"}`);
}

// Mint a short-lived Copilot token from the long-lived GitHub token.
export async function refreshGitHubCopilotToken(
  githubToken: string,
  enterpriseDomain?: string,
): Promise<CopilotCredentials> {
  const domain = enterpriseDomain || "github.com";
  const raw = (await fetchJson(getUrls(domain).copilotTokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      ...COPILOT_HEADERS,
    },
  })) as Record<string, unknown>;
  const token = raw.token;
  const expires = resolveExpiresAtMsFromEpochSeconds(raw.expires_at, { bufferMs: EPOCH_SKEW_MS });
  if (typeof token !== "string" || expires === undefined) {
    throw new Error("Invalid Copilot token response");
  }
  return { refresh: githubToken, access: token, expires, enterpriseUrl: enterpriseDomain };
}

export async function loginGitHubCopilot(
  callbacks: OAuthLoginCallbacks,
): Promise<CopilotCredentials> {
  const input = await callbacks.onPrompt({
    message: "GitHub Enterprise URL/domain (blank for github.com)",
    placeholder: "company.ghe.com",
    allowEmpty: true,
  });
  if (callbacks.signal?.aborted) throw new Error("Login cancelled");
  const trimmed = input.trim();
  const enterpriseDomain = normalizeDomain(input);
  if (trimmed && !enterpriseDomain) throw new Error("Invalid GitHub Enterprise URL/domain");
  const domain = enterpriseDomain || "github.com";

  const device = await startDeviceFlow(domain, callbacks.signal);
  callbacks.onAuth({
    url: device.verification_uri,
    instructions: `Enter code: ${device.user_code}`,
  });

  const githubToken = await pollForGitHubAccessToken(
    domain,
    device.device_code,
    device.intervalMs,
    device.expiresAt,
    callbacks.signal,
  );
  callbacks.onProgress?.("Exchanging GitHub token for a Copilot token...");
  return refreshGitHubCopilotToken(githubToken, enterpriseDomain ?? undefined);
}

export const githubCopilotOAuthProvider: OAuthProviderInterface = {
  id: "github-copilot",
  name: "GitHub Copilot",
  usesCallbackServer: false,
  login: loginGitHubCopilot,
  refreshToken: (creds) =>
    refreshGitHubCopilotToken(creds.refresh, (creds as CopilotCredentials).enterpriseUrl),
  getApiKey: (creds) => creds.access,
};
