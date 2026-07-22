import type {
  CreateKeyInput,
  ExecutionResult,
  KeyStore,
  Lane,
  MemoryStore,
  OAuthQuotaStore,
  OAuthSelectionStrategy,
  OAuthUsageStore,
  PoliciesConfig,
  RouteOptions,
  StoredCleanupReport,
  TelemetryStore,
} from "@helm/core";
import type {
  ClassifierConfig,
  DecisionRecord,
  InternalRequest,
  OAuthQuotaWindow,
  RuntimeSettings,
} from "@helm/shared";
import type { ModelOption } from "../../oauth/effective-models.js";
import type { ResetCreditGuard } from "../../oauth/reset-credit-guard.js";
import type { PayloadCaptureDeps } from "../payload-capture.js";
import type { OAuthTester } from "./oauth-test.js";

export type UsageLimitWriteMode = "extend" | "replace";

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
// (fail-closed, Principle 2). `lanes` is a name->Lane map matching LanesConfig.
export interface RuleStore {
  getLanes(): Promise<Record<string, Lane>>;
  setLanes(lanes: Record<string, Lane>): Promise<void>;
  updateLanes(
    mutate: (current: Record<string, Lane>) => Record<string, Lane> | Promise<Record<string, Lane>>,
  ): Promise<Record<string, Lane>>;
  getPolicies(): Promise<PoliciesConfig>;
  setPolicies(policies: PoliciesConfig): Promise<void>;
  updatePolicies(
    mutate: (current: PoliciesConfig) => PoliciesConfig | Promise<PoliciesConfig>,
  ): Promise<PoliciesConfig>;
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

export interface KeySecretCipher {
  encrypt(plaintext: string): string;
  decrypt(blob: string): string;
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
    // Codex subscription identity claims. Optional for legacy records and every
    // non-Codex provider; no token or secret material crosses this boundary.
    email?: string;
    chatgptPlanType?: string;
    chatgptAccountId?: string;
    isFedramp?: boolean;
    expiresAt: number | null;
    updatedAt: number;
    healthy: boolean;
    // Durable credential rejection. While true, reconnect is the only recovery path;
    // priority/fast-mode edits may still be saved, but the schedulable toggle cannot
    // put the account back into the routing pool.
    credentialFailed?: boolean;
    // Effective pool scheduling (defaults applied: priority 50, schedulable true),
    // folded into the list so the providers page renders + inline-edits them without
    // an N+1 per-account GET. LOWER priority = served first; schedulable false parks
    // the account (kept connected, never routed).
    priority: number;
    schedulable: boolean;
    // Codex only: auto-consume a reset credit when the weekly window saturates
    // (default false). Folded in so the providers page can pre-fill the reset dialog.
    autoReset: boolean;
    // Per-account Fast mode, folded in so the providers page can inline-edit it.
    fastMode: boolean;
    // The account's egress proxy, REDACTED (principle 7: never the password, only
    // `hasPassword`) — or null for a direct connection. Folded into the list from the
    // SAME already-loaded settings blob as priority/schedulable, so the providers page
    // shows "which proxy" without the per-account GET the Manage dialog uses.
    proxy: AccountProxyView | null;
    // Models shown for this account: the saved allowlist in manual mode, or the
    // account-scoped discovery result in auto mode. Discovery fails open to [].
    models: string[];
  }>;
}

export interface OAuthAdminStatusResponse {
  // Global account-pool selection strategy. This chooses BETWEEN connected accounts
  // inside each subscription provider pool; Lanes/Policies still choose the model
  // and provider chain.
  selectionStrategy: OAuthSelectionStrategy;
  providers: OAuthAdminStatus[];
}

export interface OAuthAdminAccess {
  // Cache-only status is the providers page read path: local token/settings/model
  // snapshots only, with no token refresh or upstream model discovery.
  listCachedStatus(): Promise<OAuthAdminStatusResponse>;
  // Explicit refresh path. `serial` bounds provider-account work to one account at
  // a time; `forceRefresh` bypasses fresh model-discovery caches.
  listStatus(options?: {
    forceRefresh?: boolean;
    serial?: boolean;
  }): Promise<OAuthAdminStatusResponse>;
  // Anthropic manual-paste: begin -> { authorizeUrl }; the verifier/state are held
  // server-side keyed by sessionId. complete exchanges the pasted redirect URL.
  // `proxy` (optional, entered in the connect dialog's first step) is validated +
  // pinned to the session so the token exchange — and the persisted account — use
  // it from the start, never the operator's real IP (issue #38).
  startManualPaste(input: {
    providerId: string;
    proxy?: AccountProxyInput;
  }): Promise<{ sessionId: string; authorizeUrl: string }>;
  completeManualPaste(input: {
    sessionId: string;
    redirectInput: string;
    account: string;
  }): Promise<void>;
  // Device code: begin -> { userCode, verificationUri, intervalMs, expiresAt };
  // the client honors the provider's cadence and stops when the code expires. Poll until done,
  // then the seam mints the Copilot token and persists it. `proxy` is pinned BEFORE
  // the first device-code call so step 1 already egresses through it (issue #38).
  startDeviceCode(input: {
    providerId: string;
    enterprise?: string;
    proxy?: AccountProxyInput;
  }): Promise<{
    sessionId: string;
    userCode: string;
    verificationUri: string;
    intervalMs: number;
    expiresAt: number;
    serverNowMs: number;
  }>;
  pollDeviceCode(input: {
    sessionId: string;
    account: string;
  }): Promise<{ status: "pending" | "slow_down" | "done" }>;
  // Remove a stored credential (admin "log out").
  logout(input: { providerId: string; account: string }): Promise<void>;
  // Per-account model curation: which discovered models are exposed to Lanes.
  // `available` is the exact discovery for the account's current token (fail-open
  // to [] when discovery fails); `enabled` is the operator's chosen
  // subset (unset settings = ALL available). Runtime composition follows the same
  // account discovery when healthy, but separately retains its curated fail-open
  // safety net when upstream discovery is unavailable.
  listModels(input: {
    providerId: string;
    account: string;
    // `canPull` = the provider has a live list-models API, so a "pull from
    // provider" action is meaningful.
  }): Promise<{
    available: string[];
    enabled: string[];
    modelsMode: "auto" | "manual";
    canPull: boolean;
  }>;
  // Persist the exposed-model subset for one account (replaces the prior list).
  setEnabledModels(input: {
    providerId: string;
    account: string;
    mode: "auto" | "manual";
    models: string[];
  }): Promise<void>;
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
    autoReset?: boolean;
    fastMode?: boolean;
  }): Promise<void>;
  // Global account-pool selection strategy. Defaults to balanced when no operator
  // setting is stored.
  getSelectionStrategy(): Promise<AccountPoolStrategyView>;
  setSelectionStrategy(input: { selectionStrategy: OAuthSelectionStrategy }): Promise<void>;
  // Pull the Anthropic OAuth usage endpoint for one account → quota windows
  // (providers page Tier 3). Claude exposes a dedicated usage endpoint, so this is
  // an on-demand PULL behind a short TTL cache. FAIL-OPEN: returns null on any
  // failure (dead token, network, malformed body) so the page renders "—" rather
  // than erroring. Optional so unit-test seams can omit it.
  fetchAnthropicQuota?(input: {
    account: string;
    force?: boolean;
  }): Promise<OAuthQuotaWindow[] | null>;
  // Pull the consumer Grok subscription's weekly usage window from Grok Build's
  // authenticated JSON billing endpoint. The existing xAI OAuth bearer is sufficient;
  // no browser cookie is persisted. Same proxy/refresh/cache/fail-open contract as
  // the other quota PULLs.
  fetchXaiQuota?(input: { account: string; force?: boolean }): Promise<OAuthQuotaWindow[] | null>;
  // Same PULL for Codex (chatgpt.com/backend-api/wham/usage — what the Codex CLI
  // /status reads). Complements the `x-codex-*` header PUSH so quota renders even
  // before an account has served any traffic. Same TTL cache + fail-open contract.
  // Returns the windows AND the available rate-limit-reset-credit count (both off
  // the one PULL); null on any failure. `resetCredits` null = no grant / unknown.
  fetchCodexQuota?(input: { account: string; force?: boolean }): Promise<CodexQuotaResult>;
  // Read the last in-process Codex quota result without refreshing an expired
  // cache. Rich quota metadata is folded into the cache-only overview when present.
  getCachedCodexQuota?(input: { account: string }): Promise<CodexQuotaResult>;
  // Consume one Codex rate-limit reset credit for the account (the "reset usage
  // limit" operator action). FAIL-CLOSED, unlike the PULLs: the seam THROWS on any
  // upstream failure so the route returns an error rather than a false success.
  // Returns the normalized four-way outcome plus the upstream `code` and restored
  // window count. A 2xx noCredit/nothingToReset response is not a successful reset.
  // Optional so unit-test seams can omit it; the route 503s when absent.
  consumeCodexResetCredit?(input: {
    account: string;
    creditId?: string;
    idempotencyKey?: string;
  }): Promise<CodexResetCreditResult>;
}

export type CodexRateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

export interface CodexCreditsView {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexIndividualLimitView {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAtMs: number | null;
}

export interface CodexAdditionalLimitView {
  limitId: string;
  limitName: string | null;
}

export interface CodexResetCreditDetailView {
  id: string;
  resetType: "codexRateLimits" | "unknown";
  status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

// The Codex quota PULL result: rate-limit windows + the available reset-credit
// count, both parsed off the single /wham/usage response. null = the whole PULL
// failed (dead token / network / not configured). `resetCredits` null = the
// account holds no reset-credit grant (or the value was unparseable).
export type CodexQuotaResult = {
  windows: OAuthQuotaWindow[];
  additionalLimits: CodexAdditionalLimitView[];
  resetCredits: number | null;
  resetCreditDetails: CodexResetCreditDetailView[] | null;
  credits: CodexCreditsView | null;
  individualLimit: CodexIndividualLimitView | null;
  planType: string | null;
  rateLimitReachedType: CodexRateLimitReachedType | null;
} | null;

// The Codex reset-credit CONSUME result surfaced to the operator. HTTP 2xx can
// still mean noCredit or nothingToReset, so callers must branch on `outcome`.
export interface CodexResetCreditResult {
  code: string | null;
  outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";
  windowsReset: number | null;
  // Locally generated idempotency/audit id sent to upstream as redeem_request_id.
  redeemRequestId?: string;
}

// The effective scheduling for one account: defaults applied (priority 50,
// schedulable true) so the UI always renders a concrete value.
export interface AccountScheduleView {
  priority: number;
  schedulable: boolean;
  // Codex only: auto-consume a reset credit when the weekly window saturates.
  autoReset: boolean;
  // Per-account Fast mode.
  fastMode: boolean;
}

export interface AccountPoolStrategyView {
  selectionStrategy: OAuthSelectionStrategy;
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

// Replay wiring (admin "Retry" button). An ISOLATED debug re-run: the route +
// provider call is re-issued through the SAME core pipeline as a live request,
// recording a NEW trace + payload — but deliberately WITHOUT the budget gate/
// settle, memory observe/inject, OAuth-usage recording, per-key rate limiting,
// or the concurrency gate a real client call carries (a debug retry must not
// bill the key nor pollute conversation memory; the quota middlewares guard the
// /v1 client surface, not a one-off operator action behind the admin Basic
// auth — see replay.ts "DELIBERATE BYPASSES").
// Reuses the composition root's `route`/`redact`/`costOf`/capture closures —
// the SAME ones wired into the chat route — so routing stays faithful. Optional
// so unit-test deps can omit it; the route 503s when absent (mirrors `oauth?`).
export interface ReplayWiring {
  route: (
    req: InternalRequest,
    opts: RouteOptions,
    signal: AbortSignal,
  ) => Promise<ExecutionResult>;
  // Redact a DecisionRecord before it is persisted (principle 7) — the same
  // redactor the chat route uses.
  redact: (payload: unknown) => unknown;
  // Wall clock (epoch ms) for the new record's createdAt.
  now: () => number;
  // Mint the NEW request's trace id (the re-run is a distinct request).
  genTraceId: () => string;
  // LIVE getter for capture_payloads (admin settings) + the streamed-cost pricer —
  // identical to the chat route's wiring. Payload retention is NOT wired here: the
  // scheduled cleanup runner owns it, so a replay never prunes bodies.
  capturePayloads?: PayloadCaptureDeps["capturePayloads"];
  costOf?: PayloadCaptureDeps["costOf"];
}

// One downloadable archive file produced by a cleanup run (the LocalVolumeSink
// writes <runId>/<table>.jsonl.gz). Surfaced by the cleanup status route so the
// admin can pull a training/audit archive off the box.
export interface CleanupArchiveEntry {
  runId: string;
  file: string; // e.g. "telemetry.jsonl.gz"
  bytes: number;
  modifiedMs: number;
}

// Read/run seam for the admin "Data cleanup" surface. All orchestration (plan from
// live settings → archive → delete → persist report, VACUUM, archive listing) is
// wired in server.ts; the route stays pure HTTP glue.
export interface CleanupAccess {
  // Run ONE cleanup pass now (the manual "Clean Now" button). Same code path as the
  // scheduled tick. Returns the run report.
  runNow(): Promise<StoredCleanupReport>;
  // The last persisted run report (null if cleanup has never run).
  lastReport(): Promise<StoredCleanupReport | null>;
  // Reclaim on-disk space (sqlite VACUUM; pg no-op). The "Compact database" button.
  vacuum(): Promise<void>;
  // List downloadable archive files (newest first).
  listArchives(): Promise<CleanupArchiveEntry[]>;
  // Resolve an archive file to an absolute path for download, or null if the
  // (runId, file) pair is unknown or would escape the archive directory.
  resolveArchive(runId: string, file: string): Promise<string | null>;
}

export interface AdminApiDeps {
  rules: RuleStore;
  keyStore: KeyStore;
  telemetry: TelemetryStore;
  // Automatic data cleanup / retention / archival (admin "Data cleanup"). Optional —
  // absent in unit tests; the cleanup routes 503 when not wired.
  cleanup?: CleanupAccess;
  // Memory management surface (docs/13). The admin "Memory" page reads/edits/
  // deletes facts + reflections through this. Optional so existing partial test
  // deps stay valid; the /admin/api/memory/* routes 503 when it is absent or when
  // the adapter lacks the management methods. Wired to store.memory in server.ts.
  memoryStore?: MemoryStore;
  // Admin "Retry" replay surface. Optional — absent in unit tests; the route 503s.
  replay?: ReplayWiring;
  // Admin OAuth-login seam (issue #38). Optional so existing tests that build a
  // partial deps object stay valid; the route 503s when it is absent.
  oauth?: OAuthAdminAccess;
  // Per-account OAuth subscription observability (providers page). `oauthUsage` =
  // today's served traffic aggregate (Tier 2); `oauthQuota` = latest rate-limit
  // window snapshot (Tier 3). Optional — the /usage + /quota routes return an empty
  // list when absent (fail-open; never 503 the whole page over observability).
  oauthUsage?: OAuthUsageStore;
  oauthQuota?: OAuthQuotaStore;
  // Hard safety gate before any Codex reset-credit consume (manual button or
  // auto-reset). Optional only for tests/disabled deployments; reset-credit routes
  // fail closed when it is absent.
  resetCreditGuard?: ResetCreditGuard;
  // Per-account connectivity tester (Subscription Providers "Test" button). Streams
  // a single short completion through a FRESH, isolated per-account client — its own
  // token + proxy + executor type, and its OWN no-op breaker — so a test records NO
  // telemetry / request_payloads and never perturbs the live routing pool. A
  // SUCCESSFUL test still records OAuth account usage and clears stale auto-park
  // cooldowns because it consumes real upstream quota and proves the account is
  // available. Optional: the /oauth/:provider/test route 503s when absent (present
  // iff OAuth is wired).
  oauthTester?: OAuthTester;
  // The catalog of routable model options the Lanes admin UI offers as combobox
  // suggestions (so an operator picks a real alias instead of hand-typing one — a
  // typo would silently break a fallback chain). Each option is `{ alias, accounts }`
  // so the picker can show the subscription account(s) under each model. A THUNK,
  // not a static array, because the OAuth-subscription part is LIVE: it reflects each
  // connected account's current curation (effectiveOAuthModelOptions) so a
  // Manage-dialog edit shows up here on the next read WITHOUT a restart. The
  // configured-provider part is static (config is immutable) and carries no account.
  // A supply-chain detail (Principle 6) exposed only to the authenticated admin
  // surface, never to API clients.
  modelAliases: () => Promise<ModelOption[]>;
  // Mint a fresh key (crypto). Injected for testability + single-source plaintext.
  genKey: () => GeneratedKeyParts;
  // Generate a key_id for a new key. Injected so tests get deterministic ids.
  genKeyId: () => string;
  // Optional encrypted recovery for API keys. When absent, new keys still work
  // and return plaintext at creation/rotation, but later reveal is unavailable.
  keySecrets?: KeySecretCipher;
  // The account a newly-created admin key belongs to (MVP: single account).
  accountId: string;
  // Token estimator (chars/4) the memory admin route uses to recompute a
  // reflection's token_estimate on an in-place text edit (docs/13). Optional: the
  // route falls back to the same heuristic when absent. Wired in server.ts.
  estimateTokens?: (text: string) => number;
  // Runtime-mutable settings access (admin "System Settings"). Read/write seam
  // wired in server.ts; the route validates the body before save (fail-closed).
  settings: SettingsAccess;
  // Hot-reload hook (issue #38 follow-up): invoked by the OAuth admin routes AFTER
  // any mutation that changes the routable pool — proxy / priority / schedulable /
  // model curation / connect (login complete) / disconnect. server.ts wires this to
  // re-synthesize the OAuth pool and swap the live provider-client map + alias set, so
  // the change takes effect on the NEXT request WITHOUT a restart (mirrors the
  // RuleStore callbacks for lanes/policies/classifier). Awaited before the route
  // returns. Resolves `{ applied }`: false means the persist SUCCEEDED but the live
  // rebuild failed — the route then returns a 503 "saved but not applied" rather than
  // a false 204, honoring the Save == applied contract. Optional: absent in unit tests
  // (treated as applied).
  onOAuthMutation?: () => Promise<{ applied: boolean }>;
  // Auto-park control (OAuth usage limit). Sets (untilMs) / clears (null) one
  // account's usage-limit cooldown on BOTH the live pool member (in place — no
  // rebuild) and the persisted snapshot. The reset route passes null ("Reset usage");
  // the /quota PULL passes a saturated window's reset. Touches ONLY the cooldown,
  // never `schedulable` (operator park stays independent). Optional — absent in unit
  // tests / when no OAuth pool is wired; the reset route 503s, the PULL park is skipped.
  applyUsageLimit?: (
    providerId: string,
    account: string,
    untilMs: number | null,
    mode?: UsageLimitWriteMode,
  ) => Promise<void>;
  // Refresh one account's live soft quota snapshot in the current OAuth pool. Used by
  // the /quota PULL so quota-aware strategies see fresh windows/reset credits without
  // waiting for a full pool rebuild. Optional in tests/disabled deployments.
  applyQuotaSnapshot?: (
    providerId: string,
    account: string,
    windows: OAuthQuotaWindow[],
    capturedAtMs: number,
    resetCredits?: number | null,
  ) => void;
  // A fresh Codex upstream PULL is authoritative quota truth, just like response
  // headers. Notify the runtime after cooldown synchronization so an opted-in 100%
  // account can auto-reset even if it was parked before another request served.
  // Cache-only GET routes must never invoke this hook.
  onCodexQuotaSaturated?: (
    providerId: "openai-codex",
    account: string,
    windows: OAuthQuotaWindow[],
    capturedAtMs: number,
    rateLimitReachedType: CodexRateLimitReachedType | null,
  ) => Promise<boolean>;
  // Durable OAuth credential failure. A refresh 400/401/403 or persistent upstream
  // 401/403 means the account needs reconnecting, not just a short cooldown. The
  // gateway persists that state and rebuilds the pool so admin status and routing agree.
  onOAuthCredentialFailure?: (providerId: string, account: string, reason: string) => Promise<void>;
}

// Re-exported for route signatures.
export type { CreateKeyInput, OAuthSelectionStrategy };

// ── Wire shapes (admin-API-only response/request projections) ────────────────

// A redacted key summary for the list view: prefix only, NEVER hash full-text or
// plaintext (Principle 7, docs/06). `key_id` identifies the row for revocation.
export interface KeySummary {
  key_id: string;
  prefix: string;
  role: "root" | "user";
  // Human-readable label so an operator can recognize which project/client a key
  // belongs to (the prefix is opaque). null = unnamed. Cosmetic — no key material.
  name: string | null;
  allowed_lanes: string[] | null;
  allow_custom_model: boolean;
  blocked_models: string[] | null;
  allow_fast_mode: boolean;
  disabled: boolean;
  // Per-key rate-limit override (docs/06). null = inherit the system default; a
  // number (0 = unlimited) overrides that dimension. Surfaced so the admin UI can
  // display + edit it. No key material — just the quota numbers (principle 7).
  rate_limit_rpm: number | null;
  rate_limit_tpm: number | null;
  // Per-key usage budgets (docs/06). null = no cap for that dimension. Surfaced so
  // the admin UI can display + edit them. over_budget_behavior is degrade|reject;
  // degrade_lane null = the system default (economy). No key material (principle 7).
  budget_requests: number | null;
  budget_tokens: number | null;
  budget_spend_usd: number | null;
  budget_window_seconds: number | null;
  over_budget_behavior: "degrade" | "reject";
  degrade_lane: string | null;
  // Per-key max in-flight requests (issue #93). null = unlimited (0 rejected by
  // the schema — null already means unlimited). Enforced only while the runtime
  // setting concurrency_queue_enabled is ON.
  concurrency_limit: number | null;
  // Per-key memory defaults (issue #97). Surfaced so the admin UI can display +
  // edit them — and, critically, ROUND-TRIP them: omitting these from the list
  // view makes the UI re-read off/null/header and silently wipe a configured
  // default on the next save. No key material (principle 7).
  memory_mode: "off" | "observe" | "inject";
  memory_project_id: string | null;
  memory_thread_source: "header" | "auto";
}

// New-key/rotated-key response: carries plaintext intentionally so the operator
// can copy it. If `recoverable` is true, encrypted material was stored and the
// admin reveal endpoint can show it later.
export interface CreatedKey {
  key_id: string;
  plaintext: string;
  prefix: string;
  recoverable?: boolean;
}

// Per-key usage rollup for the /admin/keys list "Usage" column (GET
// /admin/api/keys/usage). One row per key that saw traffic in the window — the
// SPA merges it into the key list by key_id (a key absent here saw zero traffic,
// rendered as 0/—). Snake_case wire shape mirroring the rest of the admin API.
// `cost_usd` stays nullable ("not measured", distinct from a measured 0); the
// counts are real COALESCE'd 0s. No key material — just the key_id + numbers.
export interface KeyUsageSummary {
  key_id: string;
  requests: number;
  error_count: number;
  cost_usd: number | null;
  total_tokens: number;
}

// Request-debug detail: the full decision trail (docs/07). BOTH the list and the
// detail endpoints return the whole DecisionRecord — it already carries
// the classification stage, matched policy, lane candidate chain, provider attempts,
// cost, error, and trace_id, and contains NO plaintext key/payload, so the SPA stays
// a pure consumer (Principle 1) and the two fallback stages stay distinct (Principle 5)
// without backend re-projection.
export type RequestDetail = DecisionRecord;
