import { randomUUID } from "node:crypto";
import {
  beginAnthropicLogin,
  beginCopilotDeviceLogin,
  beginOpenAICodexLogin,
  type CopilotDeviceStart,
  completeAnthropicLogin,
  completeOpenAICodexLogin,
  createTokenManager,
  encryptSecret,
  getOAuthProvider,
  type OAuthCredentials,
  type OAuthTokenStore,
  pollCopilotDeviceOnce,
  refreshGitHubCopilotToken,
} from "@helm/core";
import type { OAuthAdminAccess, OAuthAdminStatus } from "../routes/admin/deps.js";

// Admin OAuth-login orchestration (issue #38) — the implementation behind the
// OAuthAdminAccess seam the /admin/api/oauth routes call. Owns the ephemeral
// per-login session state (PKCE verifier/state for Anthropic; device code/domain
// for Copilot), the upstream exchange (via the core OAuth kit), at-rest
// ENCRYPTION (token-cipher), and the OAuthTokenStore write-back.
//
// SECURITY (principle 7): the encryption key is resolved at the composition root
// and handed in as a Buffer (never an env name here). Sessions live in memory only
// and hold short-lived flow state, never a long-lived secret beyond the login.

const ANTHROPIC = "anthropic";
const COPILOT = "github-copilot";
const CODEX = "openai-codex";
const SESSION_TTL_MS = 15 * 60 * 1000;

// Manual-paste (authorization-code) providers and their begin/complete step-fns.
const MANUAL_FLOWS: Record<
  string,
  {
    begin: () => { authorizeUrl: string; verifier: string; state: string };
    complete: (input: {
      redirectInput: string;
      verifier: string;
      state: string;
    }) => Promise<OAuthCredentials>;
  }
> = {
  [ANTHROPIC]: { begin: beginAnthropicLogin, complete: completeAnthropicLogin },
  [CODEX]: { begin: beginOpenAICodexLogin, complete: completeOpenAICodexLogin },
};

type Session =
  | { kind: "manual"; providerId: string; verifier: string; state: string; createdAt: number }
  | {
      kind: "device";
      providerId: string;
      deviceCode: string;
      domain: string;
      enterpriseDomain?: string;
      createdAt: number;
    };

export interface OAuthAdminDeps {
  store: OAuthTokenStore;
  encKey: Buffer;
  now?: () => number;
  genSessionId?: () => string;
}

// Split a credential into store fields. `meta` carries every key beyond the
// canonical {access, refresh, expires} (e.g. copilot enterpriseUrl).
function metaFrom(creds: OAuthCredentials): string | null {
  const { access: _a, refresh: _r, expires: _e, ...rest } = creds;
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
}

export function createOAuthAdmin(deps: OAuthAdminDeps): OAuthAdminAccess {
  const now = deps.now ?? (() => Date.now());
  const genId = deps.genSessionId ?? (() => randomUUID());
  const sessions = new Map<string, Session>();

  function prune(): void {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) if (s.createdAt < cutoff) sessions.delete(id);
  }

  function take(sessionId: string): Session {
    prune();
    const s = sessions.get(sessionId);
    if (!s) throw new Error("login session not found or expired — start again");
    return s;
  }

  async function persist(
    providerId: string,
    account: string,
    creds: OAuthCredentials,
  ): Promise<void> {
    await deps.store.upsert({
      providerId,
      account,
      accessEnc: encryptSecret(creds.access, deps.encKey),
      refreshEnc: encryptSecret(creds.refresh, deps.encKey),
      expiresAt: creds.expires,
      meta: metaFrom(creds),
      updatedAt: now(),
    });
  }

  // Ensure a stored account's access token is fresh — the SAME lazy refresh the
  // execution path uses (openclaw-style: refresh when expired/near, write back),
  // but triggered on page view so the UI shows a live, just-renewed expiry instead
  // of a stale "expired". A still-valid token is a no-op (no network). Returns the
  // (possibly updated) expiry + a health flag: `healthy:false` means the durable
  // credential itself failed to refresh — the account needs re-connecting.
  async function ensureFresh(
    providerId: string,
    account: string,
    stored: { expiresAt: number | null; updatedAt: number },
  ): Promise<{ account: string; expiresAt: number | null; updatedAt: number; healthy: boolean }> {
    const provider = getOAuthProvider(providerId);
    if (!provider) return { account, ...stored, healthy: true };
    const tm = createTokenManager({
      oauth: { kind: "preset", providerId, account },
      tokenStore: deps.store,
      encKey: deps.encKey,
      oauthProvider: provider,
      now,
    });
    let healthy = true;
    try {
      await tm.getAuthHeader(); // refresh-if-expired + write back; no-op when fresh
    } catch {
      healthy = false; // refresh-token / durable credential is dead → needs re-login
    }
    const r = await deps.store.get(providerId, account);
    return {
      account,
      expiresAt: r?.expiresAt ?? stored.expiresAt,
      updatedAt: r?.updatedAt ?? stored.updatedAt,
      healthy,
    };
  }

  return {
    async listStatus(): Promise<OAuthAdminStatus[]> {
      const rows = await deps.store.list();
      // Ensure-fresh every stored account in parallel so the page reflects live,
      // auto-renewed expiries (and surfaces a dead credential as unhealthy).
      const refreshed = await Promise.all(
        rows.map(async (r) => ({
          providerId: r.providerId,
          ...(await ensureFresh(r.providerId, r.account, r)),
        })),
      );
      const accountsFor = (id: string) =>
        refreshed.filter((x) => x.providerId === id).map(({ providerId: _p, ...rest }) => rest);
      return [
        {
          id: ANTHROPIC,
          name: "Anthropic (Claude Pro/Max)",
          flow: "manual_paste",
          accounts: accountsFor(ANTHROPIC),
        },
        {
          id: CODEX,
          name: "ChatGPT Plus/Pro (Codex)",
          flow: "manual_paste",
          accounts: accountsFor(CODEX),
        },
        {
          id: COPILOT,
          name: "GitHub Copilot",
          flow: "device_code",
          accounts: accountsFor(COPILOT),
        },
      ];
    },

    async startManualPaste({ providerId }) {
      const flow = MANUAL_FLOWS[providerId];
      if (!flow) {
        throw new Error(`provider '${providerId}' does not support the manual-paste flow`);
      }
      const { authorizeUrl, verifier, state } = flow.begin();
      const sessionId = genId();
      sessions.set(sessionId, { kind: "manual", providerId, verifier, state, createdAt: now() });
      return { sessionId, authorizeUrl };
    },

    async completeManualPaste({ sessionId, redirectInput, account }) {
      const s = take(sessionId);
      if (s.kind !== "manual") throw new Error("wrong flow for this session");
      const flow = MANUAL_FLOWS[s.providerId];
      if (!flow)
        throw new Error(`provider '${s.providerId}' does not support the manual-paste flow`);
      const creds = await flow.complete({
        redirectInput,
        verifier: s.verifier,
        state: s.state,
      });
      await persist(s.providerId, account, creds);
      sessions.delete(sessionId);
    },

    async startDeviceCode({ providerId, enterprise }) {
      if (providerId !== COPILOT) {
        throw new Error(`provider '${providerId}' does not support the device-code flow`);
      }
      const start: CopilotDeviceStart = await beginCopilotDeviceLogin(enterprise);
      const sessionId = genId();
      sessions.set(sessionId, {
        kind: "device",
        providerId,
        deviceCode: start.deviceCode,
        domain: start.domain,
        enterpriseDomain: start.enterpriseDomain,
        createdAt: now(),
      });
      return { sessionId, userCode: start.userCode, verificationUri: start.verificationUri };
    },

    async pollDeviceCode({ sessionId, account }) {
      const s = take(sessionId);
      if (s.kind !== "device") throw new Error("wrong flow for this session");
      const result = await pollCopilotDeviceOnce({ domain: s.domain, deviceCode: s.deviceCode });
      if (result.status !== "done") return { status: result.status };
      const creds = await refreshGitHubCopilotToken(result.githubToken, s.enterpriseDomain);
      await persist(s.providerId, account, creds);
      sessions.delete(sessionId);
      return { status: "done" };
    },

    async logout({ providerId, account }) {
      await deps.store.delete(providerId, account);
    },
  };
}
