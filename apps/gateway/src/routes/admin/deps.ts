import type { CreateKeyInput, KeyStore, Lane, PoliciesConfig, TelemetryStore } from "@helm/core";
import type { ClassifierConfig, DecisionRecord, RuntimeSettings } from "@helm/shared";

// Injected dependency contracts for the admin API. Per CLAUDE.md principle 1 the
// route files are PURE HTTP glue — they own no business logic and never touch the
// filesystem or DB directly. The two persistence targets are deliberately separate
// (CLAUDE.md Principle 2, config-as-code):
//   - RULE config (lanes / policies / classifier) -> RuleStore (config/*.yaml or
//     a runtime ConfigStore). Versionable, never the DB.
//   - RUNTIME state (keys / telemetry) -> KeyStore / TelemetryStore. Never yaml.
// The concrete RuleStore (YAML-backed) is wired in server.ts; tests inject an
// in-memory fake so the routes stay framework- and IO-free to unit test.

// A typed read/write seam for the rule configs. Each accessor returns/accepts an
// already-validated config object — the routes Zod-validate the inbound body
// BEFORE calling `set*` so an invalid config is rejected (400) and never written
// (fail-closed, Principle 2). `lanes` is a name->Lane map matching LanesConfig minus the
// `balanced`-required refinement concern (the route enforces shape via LaneSchema).
export interface RuleStore {
  getLanes(): Promise<Record<string, Lane>>;
  setLanes(lanes: Record<string, Lane>): Promise<void>;
  getPolicies(): Promise<PoliciesConfig>;
  setPolicies(policies: PoliciesConfig): Promise<void>;
  getClassifier(): Promise<ClassifierConfig>;
  setClassifier(cfg: ClassifierConfig): Promise<void>;
}

// Read/write seam for runtime-mutable settings (admin "System Settings" page).
// `get` returns the LIVE value; `save` validates + persists to the config_kv
// store + applies live (logger level, rate-limit switch) — all wired in server.ts.
// The route Zod-validates the inbound body against RuntimeSettingsSchema BEFORE
// calling save (fail-closed, Principle 2), so an invalid object is rejected (400) and
// never persisted nor applied.
export interface SettingsAccess {
  get(): RuntimeSettings;
  save(next: RuntimeSettings): Promise<RuntimeSettings>;
}

// Key creation needs to mint a plaintext + hash + prefix. We inject the generator
// (auth.keygen.generateKey) so the route never depends on crypto directly and the
// plaintext is produced at exactly one place, returned once, never persisted.
export interface GeneratedKeyParts {
  plaintext: string;
  hash: string;
  prefix: string;
}

// Read/write seam for the admin OAuth-login surface (issue #38). The routes stay
// pure HTTP glue (Principle 1): all flow orchestration (ephemeral PKCE/device
// session state, the upstream token exchange, at-rest encryption, and the
// OAuthTokenStore write-back) lives behind this seam, wired in server.ts. A
// preset subscription login (Claude Pro/Max via manual-paste, GitHub Copilot via
// device code) is an OPERATOR action behind the admin basicAuth — never an
// API-client surface (Principle 6). No method ever returns secret material.
export interface OAuthAdminStatus {
  id: string; // provider id: 'anthropic' | 'github-copilot' | 'openai-codex'
  name: string;
  flow: "manual_paste" | "device_code"; // shapes the UI
  // `healthy` reflects whether the account's token could be (re)obtained when the
  // status was read — true once it has a working durable credential, false when a
  // refresh failed (needs reconnecting). The short-lived access-token `expiresAt`
  // is informational; the gateway auto-renews it (so it is NOT an alarm signal).
  accounts: Array<{
    account: string;
    expiresAt: number | null;
    updatedAt: number;
    healthy: boolean;
  }>;
}

export interface OAuthAdminAccess {
  // Built-in providers + which accounts are currently logged in (no secrets).
  listStatus(): Promise<OAuthAdminStatus[]>;
  // Anthropic manual-paste: begin -> { authorizeUrl }; the verifier/state are held
  // server-side keyed by sessionId. complete exchanges the pasted redirect URL.
  startManualPaste(input: {
    providerId: string;
  }): Promise<{ sessionId: string; authorizeUrl: string }>;
  completeManualPaste(input: {
    sessionId: string;
    redirectInput: string;
    account: string;
  }): Promise<void>;
  // Copilot device code: begin -> { userCode, verificationUri }; poll until done,
  // then the seam mints the Copilot token and persists it.
  startDeviceCode(input: {
    providerId: string;
    enterprise?: string;
  }): Promise<{ sessionId: string; userCode: string; verificationUri: string }>;
  pollDeviceCode(input: {
    sessionId: string;
    account: string;
  }): Promise<{ status: "pending" | "slow_down" | "done" }>;
  // Remove a stored credential (admin "log out").
  logout(input: { providerId: string; account: string }): Promise<void>;
  // Per-account model curation: which discovered models are exposed to Lanes.
  // `available` is the live/curated discovery for the account's current token
  // (fail-open to [] when discovery fails); `enabled` is the operator's chosen
  // subset (unset settings = ALL available, so a never-curated account exposes
  // everything). Only the `enabled` models become routable `<provider>/<model>`
  // aliases (server.ts synthesizeOAuthProviders applies the same filter).
  listModels(input: {
    providerId: string;
    account: string;
    // `canPull` = the provider has a live list-models API, so a "pull from
    // provider" action is meaningful (false for curated-only providers e.g. Codex).
  }): Promise<{ available: string[]; enabled: string[]; canPull: boolean }>;
  // Persist the exposed-model subset for one account (replaces the prior list).
  setEnabledModels(input: { providerId: string; account: string; models: string[] }): Promise<void>;
  // Per-account egress proxy (issue #38 follow-up). Multiple accounts of one
  // provider must not share an egress IP (ban-correlation risk), so each account
  // may pin an http/https/socks5 proxy its upstream traffic tunnels through.
  // SECURITY (principle 7): the read NEVER returns the password — only whether one
  // is set (`hasPassword`). null = no proxy configured (direct connection).
  getAccountProxy(input: { providerId: string; account: string }): Promise<AccountProxyView | null>;
  // Persist or CLEAR (proxy = null) one account's proxy. A clear drops the proxy
  // field so the account reverts to a direct connection.
  setAccountProxy(input: {
    providerId: string;
    account: string;
    proxy: AccountProxyInput | null;
  }): Promise<void>;
  // Per-account scheduling (issue #38 Stage 3). When a provider has several
  // connected accounts, the gateway pools them: `priority` (LOWER = preferred,
  // default 50) orders the pool and `schedulable` (default true) parks an account
  // out of rotation without disconnecting it. Round-robin (LRU) breaks ties within
  // an equal priority. Read returns the effective values (defaults applied).
  getAccountSchedule(input: { providerId: string; account: string }): Promise<AccountScheduleView>;
  // Persist one account's scheduling knobs. Either field may be omitted to leave
  // it unchanged; the route validates `priority` is a finite integer first.
  setAccountSchedule(input: {
    providerId: string;
    account: string;
    priority?: number;
    schedulable?: boolean;
  }): Promise<void>;
}

// The effective scheduling for one account: defaults applied (priority 50,
// schedulable true) so the UI always renders a concrete value.
export interface AccountScheduleView {
  priority: number;
  schedulable: boolean;
}

// Redacted proxy projection for the admin read path: the password is NEVER echoed,
// only `hasPassword` so the UI can show "password set" without revealing it.
export interface AccountProxyView {
  type: "http" | "https" | "socks5";
  host: string;
  port: number;
  username?: string;
  hasPassword: boolean;
}

// Proxy write shape. `password` omitted/undefined on an UPDATE preserves the stored
// password (so the operator can edit host/port without re-entering it); an empty
// string explicitly clears it.
export interface AccountProxyInput {
  type: "http" | "https" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface AdminApiDeps {
  rules: RuleStore;
  keyStore: KeyStore;
  telemetry: TelemetryStore;
  // Admin OAuth-login seam (issue #38). Optional so existing tests that build a
  // partial deps object stay valid; the route 503s when it is absent.
  oauth?: OAuthAdminAccess;
  // The catalog of routable model aliases the Lanes admin UI offers as combobox
  // suggestions (so an operator picks a real alias instead of hand-typing one — a
  // typo would silently break a fallback chain). A THUNK, not a static array,
  // because the OAuth-subscription part is LIVE: it reflects each connected
  // account's current curation (effectiveOAuthAliases) so a Manage-dialog edit shows
  // up here on the next read WITHOUT a restart. The configured-provider part is
  // static (config is immutable for the process). A supply-chain detail (Principle
  // 6) exposed only to the authenticated admin surface, never to API clients.
  modelAliases: () => Promise<string[]>;
  // Mint a fresh key (crypto). Injected for testability + single-source plaintext.
  genKey: () => GeneratedKeyParts;
  // Generate a key_id for a new key. Injected so tests get deterministic ids.
  genKeyId: () => string;
  // The account a newly-created admin key belongs to (MVP: single account).
  accountId: string;
  // Runtime-mutable settings access (admin "System Settings"). Read/write seam
  // wired in server.ts; the route validates the body before save (fail-closed).
  settings: SettingsAccess;
}

// Re-exported for route signatures.
export type { CreateKeyInput };

// ── Wire shapes (admin-API-only response/request projections) ────────────────

// A redacted key summary for the list view: prefix only, NEVER hash full-text or
// plaintext (Principle 7, docs/06). `key_id` identifies the row for revocation.
export interface KeySummary {
  key_id: string;
  prefix: string;
  role: "root" | "user";
  max_lane: string | null;
  allowed_lanes: string[] | null;
  allow_custom_model: boolean;
  disabled: boolean;
  // Per-key rate-limit override (docs/06). null = inherit the system default; a
  // number (0 = unlimited) overrides that dimension. Surfaced so the admin UI can
  // display + edit it. No key material — just the quota numbers (principle 7).
  rate_limit_rpm: number | null;
  rate_limit_tpm: number | null;
}

// New-key response: the ONLY place plaintext is ever returned, once.
export interface CreatedKey {
  key_id: string;
  plaintext: string;
}

// Request-debug detail: the full decision trail (docs/07). BOTH the list and the
// detail endpoints return the whole DecisionRecord — it already carries
// the classification stage, matched policy, lane candidate chain, provider attempts,
// cost, error, and trace_id, and contains NO plaintext key/payload, so the SPA stays
// a pure consumer (Principle 1) and the two fallback stages stay distinct (Principle 5)
// without backend re-projection.
export type RequestDetail = DecisionRecord;
