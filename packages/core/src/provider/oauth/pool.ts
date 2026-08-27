// OAuth account POOL client (issue #38, Stage 3). A single ProviderClient that
// fronts N per-account clients of ONE subscription provider (each already built
// with its own token manager + egress proxy + executor type). On every call it
// SELECTS one account, then delegates the whole request to that account's client.
//
// Selection: when the request carries a stable session/device fingerprint, bind it
// to one account by deterministic rendezvous hashing inside the lowest-priority
// eligible tier. That makes new sessions spread across equal-priority accounts,
// while repeated turns stay on the same account unless it is parked, usage-limited,
// or currently at capacity. Requests with no session signal keep the old LRU
// round-robin behavior inside the lowest-priority tier.
//
// Fail-closed (principle 2): a pool with no schedulable member cannot serve, so
// the call throws — the executor records the failure and advances the chain, never
// silently picks a parked account. Streaming and non-streaming share the SAME
// selection (one pick per call), so a streamed request also rotates the pool.

import { createHash } from "node:crypto";
import {
  isNativePassthroughCarrier,
  type NativePassthroughInput,
  nativePassthroughBody,
  type OAuthQuotaWindow,
} from "@helm/shared";
import { isUserMessageRequest } from "../../queue/user-turn.js";
import { guardPreOutputFailure, type PreOutputClassifier } from "../failover-guard.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ImageEditInput,
  type ProviderCallOptions,
  type ProviderClient,
  type RealtimeCallRequest,
  type RealtimeCallResult,
  UpstreamError,
} from "../openai.js";
import {
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  CodexResponsesBeforeSendError,
} from "../openai-responses.js";
import { TokenRefreshError } from "../token-manager.js";
import { DEFAULT_429_COOLDOWN_MS } from "./usage-limit.js";

const RETRYABLE_ACCOUNT_FAILURE_COOLDOWN_MS = 30_000;

// Which PRE-FIRST-CHUNK failure justifies trying a SIBLING account in the same pool
// before the executor advances to the next alias. A Codex (openai_responses + native
// tools) request has NO valid cross-protocol fallback — every non-Responses alias is
// skipped — so the only real fallback is another account of the SAME subscription. We
// retry only TRANSIENT, account-agnostic server faults (a 5xx / overload / connect
// timeout on one account says nothing about its siblings) and DELIBERATELY exclude
// deterministic request-shape 4xx (400/413/422) — a sibling would hit those
// identically, so surface them immediately for executor classification. The one bounded
// exception is an exact invalid previous_response_id: the id is account-local, so the
// pool probes each sibling until it finds and remembers the account that owns it.
// Account-local
// OAuth credential/rate-limit statuses are handled by the dedicated helpers below,
// because those statuses can say something about the selected subscription account,
// not about the model alias. Credential statuses remain provider-configurable for
// providers that explicitly document a different authentication status contract.
// Non-UpstreamError (client abort, programmer error) is never retried.
function isRetryableTransientError(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false;
  if (err.errorClass === "timeout") return true; // connect/TTFB timeout (pre-first-chunk)
  const status = err.upstreamStatus;
  if (status === null) return true; // network / overload with no HTTP status
  return status >= 500; // 5xx incl. 529 (overloaded); excludes 429 + every other 4xx
}

// Token refresh/auth failures are scoped to the selected subscription account.
// If one account's stored refresh token is rejected, a healthy sibling should rescue
// the request instead of letting the executor trip the alias-wide circuit breaker.
function isCredentialAccountFailure(
  err: unknown,
  upstreamCredentialFailureStatuses: ReadonlySet<number>,
): boolean {
  if (err instanceof TokenRefreshError) {
    return err.permanentCredentialFailure;
  }
  if (err instanceof UpstreamError) {
    return err.upstreamStatus !== null && upstreamCredentialFailureStatuses.has(err.upstreamStatus);
  }
  return false;
}

// Usage/rate limits are also subscription-account scoped. The pool must park the
// selected account and try a sibling; otherwise one exhausted account can open the
// alias-wide breaker for every account exposing the same model. A token-refresh 429
// (the account's OAuth refresh endpoint is itself rate-limited) is equally account-
// scoped — back that account off and let a sibling serve, never the model alias.
function isRateLimitAccountFailure(err: unknown): boolean {
  if (err instanceof TokenRefreshError) return err.httpStatus === 429;
  return err instanceof UpstreamError && err.upstreamStatus === 429;
}

function isRetryableAccountFailure(err: unknown): boolean {
  return err instanceof TokenRefreshError && err.retryableAccountFailure;
}

// The per-account user-message queue reports backpressure with this structural flag.
// Treat it as account-scoped capacity pressure: try a sibling account before surfacing
// a terminal 503. No instanceof check, because the class may cross package boundaries.
function isAccountBackpressureFailure(err: unknown): boolean {
  return err instanceof Error && (err as { queueTimeout?: unknown }).queueTimeout === true;
}

// One account in the pool: its scheduling knobs plus the fully-wired client that
// carries that account's credential + proxy. `lastUsedAt` is MUTABLE soft state
// (round-robin cursor); it starts at 0 so an untouched account is always preferred
// over one that has already served.
export interface OAuthPoolMember {
  account: string;
  priority: number;
  schedulable: boolean;
  // Optional per-account model entitlement. Undefined preserves the legacy
  // "supports every routed model" behavior; an explicit empty list supports none.
  models?: readonly string[];
  // Optional per-model entitlement expiry. Models omitted from this map keep the
  // legacy non-expiring behavior; a mapped model is re-checked against the live
  // clock on every discovery/read/create selection.
  modelValidUntilMs?: Readonly<Record<string, number>>;
  client: ProviderClient;
  // Optional live capacity probe. When true, the pool prefers another eligible account
  // before committing this request. If every eligible account is busy, selection falls
  // back to the normal target and lets that member's queue wait.
  isAtCapacity?: () => boolean;
  // Auto-park cooldown: epoch ms until which this account is removed from selection
  // because it hit its usage/rate limit (null/undefined = eligible). Distinct from
  // `schedulable` (the operator's manual park). MUTABLE soft state — the gateway flips
  // it in place via `setUsageLimit` on a 429 / saturated-window signal, and re-seeds it
  // from the persisted quota snapshot on pool (re)synthesis. The gate is re-checked
  // against `now` on every select(), so recovery is AUTOMATIC once the timestamp passes
  // — no timer, no sweep.
  usageLimitedUntilMs?: number | null;
  // Operator opt-in (per account): keep serving from this account even while its
  // usage-limit park (`usageLimitedUntilMs`) is active, so its remaining credits are
  // spent instead of the account sitting idle until reset. Upstream still 429s if the
  // account is genuinely out of budget, so the pool fails over normally in that case.
  // Does NOT affect model-scoped or transient retryable cooldowns — only the account
  // usage-limit gate.
  allowSpendRemainingCredits?: boolean;
  // Latest quota windows for strategy-only scoring. These are soft observability
  // signals: stale/missing windows must never make the pool fail closed.
  quotaWindows?: OAuthQuotaWindow[];
  quotaCapturedAtMs?: number | null;
  // Codex only: available rate-limit reset credits captured with the latest usage
  // snapshot. Soft signal for quota-aware scoring; never consumed by selection.
  quotaResetCredits?: number | null;
}

export type OAuthSelectionStrategy = "balanced" | "manual_priority" | "low_risk" | "use_expiring";

// The pool's ProviderClient plus an out-of-band mutator the gateway uses to park /
// un-park a single account in O(1) — a single 429 must NOT rebuild the whole pool
// (which re-refreshes every token). `setUsageLimit` on an unknown account is a no-op
// (the member may have been dropped by a concurrent rebuild). Passing null after
// a successful account test clears every soft cooldown for that account.
export interface OAuthPoolClient extends ProviderClient {
  hasAvailableModel(model: string): boolean;
  setUsageLimit(account: string, untilMs: number | null): void;
  // Restore only the persisted account-wide park after a hot rebuild. Unlike the
  // explicit reset path above, this must preserve transient/model-scoped cooldowns.
  seedUsageLimit(account: string, untilMs: number | null): void;
  // The account's current auto-park cooldown (epoch ms), or null if eligible now. Lets
  // the gateway make a park EXTEND-ONLY — never shorten a precise quota reset already set.
  getUsageLimit(account: string): number | null;
  setQuotaSnapshot(
    account: string,
    windows: OAuthQuotaWindow[],
    capturedAtMs: number,
    resetCredits?: number | null,
  ): void;
}

export interface OAuthRateLimitParkContext {
  account: string;
  model: string | null;
  error: unknown;
}

export type OAuthRateLimitScope =
  | { scope: "account" }
  | { scope: "model"; model: string; limitId: string | null };

export interface OAuthPoolDeps {
  members: OAuthPoolMember[];
  // Injected clock (default Date.now) so the LRU cursor is testable.
  now?: () => number;
  // Native CLI safety: bind repeated requests with the same client/session
  // fingerprint to the same OAuth account for this TTL.
  stickyTtlMs?: number;
  // Bound untrusted client/session identifiers. Expired entries are pruned on
  // selection and least-recently-used entries are evicted under a key flood.
  maxStickySessions?: number;
  // Fires with the selected account on each served call — the seam the gateway
  // uses to record the serving subscription in telemetry / logs (no secrets).
  onSelect?: (account: string, selection: OAuthPoolSelection) => void;
  // Fires when the selected account hits an account-wide upstream 429. The pool already
  // applies the in-memory cooldown before calling this; the hook lets the gateway persist
  // the same cooldown so rebuilds/restarts keep routing around the account.
  onAccountRateLimit?: (account: string, untilMs: number) => void;
  accountRateLimitCooldownMs?: number;
  selectionStrategy?: OAuthSelectionStrategy;
  quotaFreshMs?: number;
  // Provider-specific inference statuses that prove the stored credential is unusable.
  // Defaults to the legacy 401/403 contract. This does not affect token-refresh errors,
  // whose permanent-failure semantics are owned by TokenRefreshError above.
  upstreamCredentialFailureStatuses?: readonly number[];
  // Optional model-aware guard for provider-specific scoped caps. Returning false
  // means "retry a sibling for this request, but do not globally park the account".
  shouldParkRateLimit?: (ctx: OAuthRateLimitParkContext) => boolean;
  // Provider-specific 429 scope. Model-scoped limits cool only this account/model
  // pair, while account-scoped limits use the durable global account park above.
  // `shouldParkRateLimit` remains as a compatibility fallback for existing callers.
  resolveRateLimitScope?: (ctx: OAuthRateLimitParkContext) => OAuthRateLimitScope;
  // Fires when a selected account's durable credential is rejected (a permanent token
  // refresh failure or an inference status selected by the provider-specific policy).
  // The pool already removes that account from this process; the hook lets the gateway
  // persist the disabled state for admin status, rebuilds, and restarts.
  onAccountCredentialFailure?: (account: string, error: unknown) => void;
  // Pre-output failover classifiers for the in-pool retry (issue: a native byte-relay
  // that 200s then fails IN-BAND after only a content-free preamble — e.g. a Responses
  // `response.created` before `response.failed`/server_is_overloaded). WITHOUT this, the
  // pool commits the account on its first RAW chunk (the preamble), so the later error
  // frame can no longer fail over to a sibling — exactly the executor-level guard's blind
  // spot, one layer too high to rotate accounts. WITH it, each member's SSE is wrapped so
  // the first yielded chunk means real output is guaranteed; a pre-output error frame
  // becomes a pre-first-chunk `UpstreamError` (null upstreamStatus → retryable), so the
  // pool tries the NEXT account instead of committing the doomed stream. Null/absent →
  // legacy commit-on-first-raw-chunk (gemini has no separate preamble, so it stays null).
  nativeStreamPreambleClassifier?: PreOutputClassifier | null; // nativePassthroughStream
  chatStreamPreambleClassifier?: PreOutputClassifier | null; // chatCompletionStream (translated)
}

// Internal mutable scheduling record (the member + its rotating cursor).
interface PoolEntry {
  member: OAuthPoolMember;
  lastUsedAt: number;
}

export interface OAuthPoolSelection {
  reason: "sticky_hit" | "hash_assign" | "lru" | "strategy";
  strategy: OAuthSelectionStrategy;
  affinityKeySource: string | null;
  capacityAvoided: boolean;
  allCandidatesAtCapacity: boolean;
  busyEligibleAccounts: number;
  retryAttempt: number;
}

export const DEFAULT_MAX_STICKY_SESSIONS = 5_000;

export function createOAuthPoolClient(deps: OAuthPoolDeps): OAuthPoolClient {
  const now = deps.now ?? (() => Date.now());
  const stickyTtlMs = deps.stickyTtlMs ?? 10 * 60 * 1000;
  const maxStickySessions = Math.max(
    1,
    Math.floor(deps.maxStickySessions ?? DEFAULT_MAX_STICKY_SESSIONS),
  );
  const accountRateLimitCooldownMs = deps.accountRateLimitCooldownMs ?? DEFAULT_429_COOLDOWN_MS;
  const selectionStrategy = deps.selectionStrategy ?? "balanced";
  const quotaFreshMs = deps.quotaFreshMs ?? 10 * 60 * 1000;
  const upstreamCredentialFailureStatuses = new Set(
    deps.upstreamCredentialFailureStatuses ?? [401],
  );
  const entries: PoolEntry[] = deps.members.map((member) => ({ member, lastUsedAt: 0 }));
  const firstNativeProtocolProfile = entries[0]?.member.client.nativeProtocolProfile;
  const nativeProtocolProfile =
    firstNativeProtocolProfile !== undefined &&
    entries.every(
      (entry) => entry.member.client.nativeProtocolProfile === firstNativeProtocolProfile,
    )
      ? firstNativeProtocolProfile
      : undefined;
  const stickySessions = new Map<string, { account: string; expiresAt: number }>();
  const scopedRateLimits = new Map<
    string,
    { account: string; model: string; limitId: string | null; untilMs: number }
  >();
  const retryableAccountFailures = new Map<string, number>();
  const credentialFailureReported = new Set<string>();
  let selectionCounter = 0;

  function rememberSticky(stickyKey: string, account: string, expiresAt: number): void {
    // Map insertion order is our LRU order. A repeated session gets a renewed
    // lease and becomes most-recent; a flood of one-off client keys stays bounded.
    stickySessions.delete(stickyKey);
    stickySessions.set(stickyKey, { account, expiresAt });
    for (const [key, value] of stickySessions) {
      if (value.expiresAt > now()) continue;
      stickySessions.delete(key);
    }
    while (stickySessions.size > maxStickySessions) {
      const oldest = stickySessions.keys().next().value;
      if (oldest === undefined) break;
      stickySessions.delete(oldest);
    }
  }

  // An account is eligible only when the operator has not parked it (`schedulable`)
  // AND its auto-park cooldown has elapsed. Re-evaluated on every select() against the
  // live clock, so a cooldown un-parks itself the instant `now` passes it.
  function usageLimited(member: OAuthPoolMember, nowMs: number): boolean {
    // Operator opted this account in to spend its remaining credits: never park it on
    // the usage-limit gate. If it is truly exhausted upstream will 429 and the normal
    // in-pool failover takes over.
    if (member.allowSpendRemainingCredits) return false;
    const until = member.usageLimitedUntilMs;
    return until != null && nowMs < until;
  }

  // A "spend remaining credits" account that IS currently past its usage-limit park.
  // usageLimited() waves it through the eligibility gate (returns false above), but it
  // is serving off paid credits / a saturated plan — real money. It must sink below any
  // healthy account so credits are the LAST resort, not a co-equal round-robin peer.
  // This is the runtime twin of the amber "still spending credits" providers badge.
  function spendingWhileLimited(member: OAuthPoolMember, nowMs: number): boolean {
    if (member.allowSpendRemainingCredits !== true) return false;
    const until = member.usageLimitedUntilMs;
    return until != null && nowMs < until;
  }

  // Prefer healthy accounts; only expose the credit-spending sink tier when NO healthy
  // account is eligible. Applied to the general candidate flow — a stateful sticky
  // continuation (isStrictAccountSticky) deliberately bypasses this on the full
  // `eligible` set so a pinned conversation is never diverted mid-flight.
  function preferHealthyTier(eligible: PoolEntry[], nowMs: number): PoolEntry[] {
    const healthy = eligible.filter((e) => !spendingWhileLimited(e.member, nowMs));
    return healthy.length > 0 ? healthy : eligible;
  }

  function retryableAccountLimited(account: string, nowMs: number): boolean {
    const until = retryableAccountFailures.get(account);
    if (until === undefined) return false;
    if (until > nowMs) return true;
    retryableAccountFailures.delete(account);
    return false;
  }

  function supportsModel(member: OAuthPoolMember, model: string | null, nowMs: number): boolean {
    if (model === null) return true;
    if (member.models !== undefined && !member.models.includes(model)) return false;
    const validUntil = member.modelValidUntilMs?.[model];
    return validUntil === undefined || (Number.isSafeInteger(validUntil) && nowMs < validUntil);
  }

  function scopedRateLimitKey(account: string, model: string, limitId: string | null): string {
    return `${account}\u0000${model}\u0000${limitId ?? ""}`;
  }

  function modelLimited(account: string, model: string | null, nowMs: number): boolean {
    if (model === null) return false;
    let limited = false;
    for (const [key, cooldown] of scopedRateLimits) {
      if (cooldown.untilMs <= nowMs) {
        scopedRateLimits.delete(key);
        continue;
      }
      if (cooldown.account === account && cooldown.model === model) limited = true;
    }
    return limited;
  }

  function headerValue(headers: Record<string, string | string[]>, name: string): string | null {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== lower) continue;
      const text = Array.isArray(value) ? value[0] : value;
      return text && text.trim().length > 0 ? text.trim() : null;
    }
    return null;
  }

  function bodyString(body: Record<string, unknown>, key: string): string | null {
    const value = body[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function objectRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  function isInvalidPreviousResponseIdFailure(stickyKey: string | null, err: unknown): boolean {
    if (
      !stickyKey?.startsWith("previous_response_id:") ||
      !(err instanceof UpstreamError) ||
      err.upstreamStatus !== 400 ||
      err.message !== "Invalid `previous_response_id`."
    ) {
      return false;
    }
    const raw = objectRecord(err.providerRaw);
    const nested = objectRecord(raw?.error);
    return nested?.type === "invalid_request_error";
  }

  function deviceIdFromMetadataUserId(userId: string): string | null {
    try {
      const parsed = objectRecord(JSON.parse(userId) as unknown);
      if (parsed === null) return null;
      return bodyString(parsed, "device_id") ?? bodyString(parsed, "deviceId");
    } catch {
      return null;
    }
  }

  function deviceAffinityKeyFromBody(body: Record<string, unknown>): string | null {
    const direct = bodyString(body, "device_id") ?? bodyString(body, "deviceId");
    if (direct !== null) return `device_id:${direct}`;
    const metadata = objectRecord(body.metadata);
    if (metadata === null) return null;
    const metadataDevice = bodyString(metadata, "device_id") ?? bodyString(metadata, "deviceId");
    if (metadataDevice !== null) return `metadata.device_id:${metadataDevice}`;
    const userId = bodyString(metadata, "user_id");
    const parsedDevice = userId === null ? null : deviceIdFromMetadataUserId(userId);
    return parsedDevice === null ? null : `metadata.user_id.device_id:${parsedDevice}`;
  }

  function stickyKeyFromNative(input: NativePassthroughInput): string | null {
    const body = nativePassthroughBody(input);
    if (isNativePassthroughCarrier(input)) {
      const turnState = headerValue(input.headers, "x-codex-turn-state");
      if (turnState !== null) return `x-codex-turn-state:${turnState}`;
    }
    const previousResponseId = bodyString(body, "previous_response_id");
    if (previousResponseId !== null) return `previous_response_id:${previousResponseId}`;
    if (isNativePassthroughCarrier(input)) {
      const websocketSession = headerValue(input.headers, CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER);
      if (websocketSession !== null) return `responses_websocket_session:${websocketSession}`;
    }
    const bodyDeviceKey = deviceAffinityKeyFromBody(body);
    if (bodyDeviceKey !== null) return bodyDeviceKey;
    if (isNativePassthroughCarrier(input)) {
      for (const header of ["device_id", "x-device-id"]) {
        const value = headerValue(input.headers, header);
        if (value !== null) return `${header}:${value}`;
      }
      for (const header of [
        "session-id",
        "thread-id",
        "session_id",
        "x-session-id",
        "prompt_cache_key",
        "conversation_id",
      ]) {
        const value = headerValue(input.headers, header);
        if (value !== null) return `${header}:${value}`;
      }
    }
    for (const key of ["session_id", "prompt_cache_key", "conversation_id"]) {
      const value = bodyString(body, key);
      if (value !== null) return `${key}:${value}`;
    }
    const metadata = objectRecord(body.metadata);
    if (metadata !== null) {
      for (const key of ["session_id", "conversation_id", "thread_id", "user_id"]) {
        const value = bodyString(metadata, key);
        if (value !== null) return `metadata.${key}:${value}`;
      }
    }
    return null;
  }

  function stickyKeyFromChat(req: ChatCompletionRequest): string | null {
    const previousResponseId = bodyString(req, "previous_response_id");
    if (previousResponseId !== null) return `previous_response_id:${previousResponseId}`;
    const deviceKey = deviceAffinityKeyFromBody(req);
    if (deviceKey !== null) return deviceKey;
    for (const key of [
      "prompt_cache_key",
      "session_id",
      "conversation_id",
      "user",
      "safety_identifier",
    ]) {
      const value = bodyString(req, key);
      if (value !== null) return `${key}:${value}`;
    }
    const metadata = objectRecord(req.metadata);
    if (metadata !== null) {
      for (const key of ["session_id", "conversation_id", "thread_id", "user_id"]) {
        const value = bodyString(metadata, key);
        if (value !== null) return `metadata.${key}:${value}`;
      }
    }
    return null;
  }

  function modelFromNative(input: NativePassthroughInput): string | null {
    const model = nativePassthroughBody(input).model;
    return typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
  }

  function modelFromChat(req: ChatCompletionRequest): string | null {
    const model = req.model;
    return typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
  }

  function stickyScore(stickyKey: string, account: string): bigint {
    return createHash("sha256")
      .update(stickyKey)
      .update("\0")
      .update(account)
      .digest()
      .readBigUInt64BE(0);
  }

  function atCapacity(entry: PoolEntry): boolean {
    try {
      return entry.member.isAtCapacity?.() === true;
    } catch {
      return false;
    }
  }

  function eligibleEntries(
    nowMs: number,
    exclude: ReadonlySet<string> | undefined,
    model: string | null,
  ): PoolEntry[] {
    return entries.filter(
      (e) =>
        e.member.schedulable &&
        supportsModel(e.member, model, nowMs) &&
        !usageLimited(e.member, nowMs) &&
        !retryableAccountLimited(e.member.account, nowMs) &&
        !modelLimited(e.member.account, model, nowMs) &&
        !exclude?.has(e.member.account),
    );
  }

  function preferredCapacityTier(
    eligible: PoolEntry[],
    avoidBusy: boolean,
  ): {
    candidates: PoolEntry[];
    capacityAvoided: boolean;
    allCandidatesAtCapacity: boolean;
    busyEligibleAccounts: number;
  } {
    if (!avoidBusy) {
      return {
        candidates: eligible,
        capacityAvoided: false,
        allCandidatesAtCapacity: false,
        busyEligibleAccounts: 0,
      };
    }
    const nonBusy = eligible.filter((e) => !atCapacity(e));
    const busyEligibleAccounts = eligible.length - nonBusy.length;
    // If every account is busy, do not fail closed. Let the chosen member's queue wait
    // and preserve the existing retry/timeout behavior.
    return {
      candidates: nonBusy.length > 0 ? nonBusy : eligible,
      capacityAvoided: nonBusy.length > 0 && busyEligibleAccounts > 0,
      allCandidatesAtCapacity: eligible.length > 0 && nonBusy.length === 0,
      busyEligibleAccounts,
    };
  }

  function chooseByLru(candidates: PoolEntry[]): PoolEntry | undefined {
    let best: PoolEntry | undefined;
    for (const e of candidates) {
      if (
        !best ||
        e.member.priority < best.member.priority ||
        (e.member.priority === best.member.priority && e.lastUsedAt < best.lastUsedAt)
      ) {
        best = e;
      }
    }
    return best;
  }

  function chooseByStickyHash(candidates: PoolEntry[], stickyKey: string): PoolEntry | undefined {
    let tierPriority: number | undefined;
    for (const e of candidates) {
      if (tierPriority === undefined || e.member.priority < tierPriority) {
        tierPriority = e.member.priority;
      }
    }
    let best: { entry: PoolEntry; score: bigint } | undefined;
    for (const e of candidates) {
      if (e.member.priority !== tierPriority) continue;
      const score = stickyScore(stickyKey, e.member.account);
      if (best === undefined || score > best.score) best = { entry: e, score };
    }
    return best?.entry;
  }

  function preferredPriorityTier(candidates: PoolEntry[]): PoolEntry[] {
    let tierPriority: number | undefined;
    for (const e of candidates) {
      if (tierPriority === undefined || e.member.priority < tierPriority) {
        tierPriority = e.member.priority;
      }
    }
    return tierPriority === undefined
      ? []
      : candidates.filter((e) => e.member.priority === tierPriority);
  }

  function quotaFresh(member: OAuthPoolMember, nowMs: number): boolean {
    const capturedAt = member.quotaCapturedAtMs;
    return capturedAt != null && capturedAt > 0 && nowMs - capturedAt <= quotaFreshMs;
  }

  function quotaWindowAppliesToModel(window: OAuthQuotaWindow, model: string | null): boolean {
    if (!window.key.startsWith("7d-")) return true;
    if (!model) return false;
    const scoped = window.key.slice(3).toLowerCase();
    return scoped.length > 0 && model.toLowerCase().includes(scoped);
  }

  function isWeeklyQuotaWindow(window: OAuthQuotaWindow): boolean {
    return (
      window.key === "secondary" ||
      window.key === "7d" ||
      window.key.startsWith("7d-") ||
      (window.windowMinutes !== null && window.windowMinutes >= 7 * 24 * 60)
    );
  }

  function expiringWindowWeight(window: OAuthQuotaWindow): number {
    return isWeeklyQuotaWindow(window) ? 2 : 1;
  }

  function resetCreditValue(entry: PoolEntry, nowMs: number): number {
    if (!quotaFresh(entry.member, nowMs)) return 0;
    const credits = entry.member.quotaResetCredits;
    if (credits == null || credits <= 0) return 0;
    // A reset credit can restore one set of Codex rate-limit windows, but spending it
    // is guarded elsewhere. Treat it as discounted virtual weekly capacity: important
    // enough to break ties and influence Avoid Waste, not enough to beat a natural
    // window that is about to reset with large unused quota.
    const cappedCredits = Math.min(Math.trunc(credits), 5);
    const virtualWeeklyValue = 100 / (7 * 24);
    // One credit contributes 5% of a full natural weekly window's weighted score.
    // This keeps credits useful for close calls without letting plan-specific credit
    // availability outweigh substantially more real quota inside the provider pool.
    return cappedCredits * virtualWeeklyValue * 0.1;
  }

  function applicableQuotaWindows(
    entry: PoolEntry,
    model: string | null,
    nowMs: number,
  ): OAuthQuotaWindow[] {
    if (!quotaFresh(entry.member, nowMs)) return [];
    return (entry.member.quotaWindows ?? []).filter((w) => quotaWindowAppliesToModel(w, model));
  }

  function quotaPressure(entry: PoolEntry, model: string | null, nowMs: number): number | null {
    const windows = applicableQuotaWindows(entry, model, nowMs);
    if (windows.length === 0) return null;
    return Math.max(...windows.map((w) => w.usedPercent));
  }

  function expiringQuotaValue(
    entry: PoolEntry,
    model: string | null,
    nowMs: number,
  ): number | null {
    let total = 0;
    for (const w of applicableQuotaWindows(entry, model, nowMs)) {
      if (w.resetsAtMs === null || w.resetsAtMs <= nowMs) continue;
      const remaining = Math.max(0, 100 - w.usedPercent);
      if (remaining <= 0) continue;
      const hoursUntilReset = Math.max((w.resetsAtMs - nowMs) / 3_600_000, 0.25);
      total += (remaining / hoursUntilReset) * expiringWindowWeight(w);
    }
    total += resetCreditValue(entry, nowMs);
    return total > 0 ? total : null;
  }

  function chooseByLowRisk(
    candidates: PoolEntry[],
    model: string | null,
    nowMs: number,
    sticky?: PoolEntry,
  ): PoolEntry | undefined {
    let best: { entry: PoolEntry; pressure: number } | undefined;
    for (const entry of preferredPriorityTier(candidates)) {
      const pressure = quotaPressure(entry, model, nowMs);
      if (pressure === null) continue;
      if (
        best === undefined ||
        pressure < best.pressure ||
        (pressure === best.pressure && entry.lastUsedAt < best.entry.lastUsedAt)
      ) {
        best = { entry, pressure };
      }
    }
    if (best === undefined) return undefined;
    const stickyPressure =
      sticky && sticky.member.priority === best.entry.member.priority
        ? quotaPressure(sticky, model, nowMs)
        : null;
    return sticky && stickyPressure !== null && stickyPressure <= best.pressure + 10
      ? sticky
      : best.entry;
  }

  function chooseByExpiringQuota(
    candidates: PoolEntry[],
    model: string | null,
    nowMs: number,
    sticky?: PoolEntry,
  ): PoolEntry | undefined {
    let best: { entry: PoolEntry; value: number } | undefined;
    for (const entry of preferredPriorityTier(candidates)) {
      const value = expiringQuotaValue(entry, model, nowMs);
      if (value === null) continue;
      if (
        best === undefined ||
        value > best.value ||
        (value === best.value && entry.lastUsedAt < best.entry.lastUsedAt)
      ) {
        best = { entry, value };
      }
    }
    if (best === undefined) return undefined;
    const stickyValue =
      sticky && sticky.member.priority === best.entry.member.priority
        ? expiringQuotaValue(sticky, model, nowMs)
        : null;
    return sticky && stickyValue !== null && stickyValue >= best.value * 0.85 ? sticky : best.entry;
  }

  function chooseByStrategy(
    candidates: PoolEntry[],
    stickyKey: string | null,
    sticky: PoolEntry | undefined,
    model: string | null,
    nowMs: number,
  ): { entry: PoolEntry | undefined; reason: OAuthPoolSelection["reason"] } {
    if (selectionStrategy === "balanced") {
      if (sticky) return { entry: sticky, reason: "sticky_hit" };
      const entry =
        stickyKey && candidates.length > 0
          ? chooseByStickyHash(candidates, stickyKey)
          : chooseByLru(candidates);
      return { entry, reason: stickyKey ? "hash_assign" : "lru" };
    }

    if (selectionStrategy === "manual_priority") {
      return sticky
        ? { entry: sticky, reason: "sticky_hit" }
        : { entry: chooseByLru(candidates), reason: "lru" };
    }

    const strategyEntry =
      selectionStrategy === "low_risk"
        ? chooseByLowRisk(candidates, model, nowMs, sticky)
        : chooseByExpiringQuota(candidates, model, nowMs, sticky);
    if (strategyEntry) {
      return {
        entry: strategyEntry,
        reason: strategyEntry === sticky ? "sticky_hit" : "strategy",
      };
    }

    if (sticky) return { entry: sticky, reason: "sticky_hit" };
    const entry =
      stickyKey && candidates.length > 0
        ? chooseByStickyHash(candidates, stickyKey)
        : chooseByLru(candidates);
    return { entry, reason: stickyKey ? "hash_assign" : "lru" };
  }

  function responseIdFromResult(result: unknown): string | null {
    const body = objectRecord(result);
    if (body === null) return null;
    const direct = bodyString(body, "id");
    if (direct !== null) return direct;
    const response = objectRecord(body.response);
    return response === null ? null : bodyString(response, "id");
  }

  function rememberResponseAffinity(result: unknown, entry: PoolEntry): void {
    const id = responseIdFromResult(result);
    if (id === null) return;
    rememberResponseIdAffinity(id, entry);
  }

  function rememberResponseIdAffinity(id: string, entry: PoolEntry): void {
    stickySessions.set(`previous_response_id:${id}`, {
      account: entry.member.account,
      expiresAt: now() + stickyTtlMs,
    });
  }

  function rememberTurnStateAffinity(headers: Headers, entry: PoolEntry): void {
    const turnState = headers.get("x-codex-turn-state")?.trim();
    if (!turnState) return;
    stickySessions.set(`x-codex-turn-state:${turnState}`, {
      account: entry.member.account,
      expiresAt: now() + stickyTtlMs,
    });
  }

  function callOptionsForEntry(
    opts: ProviderCallOptions | undefined,
    entry: PoolEntry,
  ): ProviderCallOptions {
    return {
      ...opts,
      onResponseMeta: (headers) => {
        rememberTurnStateAffinity(headers, entry);
        try {
          opts?.onResponseMeta?.(headers);
        } catch {
          // Request-scoped response metadata observers are fail-open.
        }
      },
    };
  }

  function streamResponseAffinityTracker(entry: PoolEntry): (chunk: string) => void {
    let buffer = "";
    return (chunk: string): void => {
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
          .trim();
        if (data !== "" && data !== "[DONE]") {
          try {
            const id = responseIdFromResult(JSON.parse(data) as unknown);
            if (id !== null) rememberResponseIdAffinity(id, entry);
          } catch {
            // A malformed/non-JSON frame cannot establish response affinity.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
      // The response.created frame is small. Bound malformed/non-SSE accumulation
      // so an account-affinity side channel can never retain an unbounded stream.
      if (buffer.length > 1_048_576) buffer = buffer.slice(-262_144);
    };
  }

  function affinityKeySource(stickyKey: string | null): string | null {
    if (stickyKey === null) return null;
    const separator = stickyKey.indexOf(":");
    return separator > 0 ? stickyKey.slice(0, separator) : "unknown";
  }

  function isStrictAccountSticky(stickyKey: string | null): stickyKey is string {
    return (
      stickyKey?.startsWith("previous_response_id:") === true ||
      stickyKey?.startsWith("x-codex-turn-state:") === true ||
      stickyKey?.startsWith("responses_websocket_session:") === true ||
      stickyKey?.startsWith("provider_account:") === true
    );
  }

  function mediaModel(req: Record<string, unknown>): string | null {
    const model = req.model;
    if (model === "grok-imagine-video-1.5") return "grok-imagine-video-1.5-preview";
    return typeof model === "string" && model.length > 0 ? model : null;
  }

  function imageEditModel(req: ImageEditInput): string | null {
    return req.kind === "json" ? mediaModel(req.body) : null;
  }

  function restorePersistedAffinity(stickyKey: string | null, account: string | undefined): void {
    if (!isStrictAccountSticky(stickyKey) || !account) return;
    rememberSticky(stickyKey, account, now() + stickyTtlMs);
  }

  function commitSelection(
    entry: PoolEntry,
    stickyKey: string | null,
    nowMs: number,
    selection: OAuthPoolSelection,
  ): PoolEntry {
    selectionCounter += 1;
    entry.lastUsedAt = selectionCounter;
    if (stickyKey) {
      rememberSticky(stickyKey, entry.member.account, nowMs + stickyTtlMs);
    }
    deps.onSelect?.(entry.member.account, selection);
    return entry;
  }

  // Pick the next account: lowest priority, then oldest lastUsedAt (LRU round-
  // robin within equal priority). Bumps the winner's cursor and notifies onSelect.
  // Throws when no member is schedulable (fail-closed — the caller treats it as a
  // provider failure and advances the fallback chain).
  // `exclude` holds accounts already TRIED-and-transiently-failed this request (in-pool
  // retry): they are skipped — both as the sticky target and in the LRU scan — so each
  // retry advances to a fresh sibling and the loop terminates (bounded by member count).
  function select(
    stickyKey?: string | null,
    exclude?: ReadonlySet<string>,
    opts: {
      avoidBusy?: boolean;
      model?: string | null;
    } = {},
  ): PoolEntry {
    const nowMs = now();
    const model = opts.model ?? null;
    const eligible = eligibleEntries(nowMs, exclude, model);
    // General selection prefers healthy accounts; the credit-spending sink tier only
    // surfaces when no healthy account is left. A strict-sticky continuation (below)
    // still uses the full `eligible` set so a pinned conversation is never diverted.
    const preferred = preferHealthyTier(eligible, nowMs);
    const capacityTier = preferredCapacityTier(preferred, opts.avoidBusy === true);
    const selectionBase = {
      affinityKeySource: affinityKeySource(stickyKey ?? null),
      capacityAvoided: capacityTier.capacityAvoided,
      allCandidatesAtCapacity: capacityTier.allCandidatesAtCapacity,
      busyEligibleAccounts: capacityTier.busyEligibleAccounts,
      retryAttempt: exclude?.size ?? 0,
      strategy: selectionStrategy,
    };
    let stickyEntry: PoolEntry | undefined;
    let knownSticky = false;
    const stickyOnly = isStrictAccountSticky(stickyKey ?? null);
    if (stickyKey) {
      const sticky = stickySessions.get(stickyKey);
      if (sticky !== undefined && sticky.expiresAt > nowMs) {
        knownSticky = true;
        const stickyCandidates = stickyOnly ? eligible : capacityTier.candidates;
        const entry = stickyCandidates.find(
          (candidate) => candidate.member.account === sticky.account,
        );
        if (entry !== undefined) {
          rememberSticky(stickyKey, sticky.account, nowMs + stickyTtlMs);
          stickyEntry = entry;
        }
      }
      if (!knownSticky) stickySessions.delete(stickyKey);
    }

    if (stickyOnly && stickyEntry) {
      return commitSelection(stickyEntry, null, nowMs, {
        ...selectionBase,
        reason: "sticky_hit",
      });
    }
    if (stickyKey?.startsWith("previous_response_id:") && !knownSticky) {
      throw new CodexResponsesBeforeSendError(
        "oauth pool: previous_response_id original account is unavailable",
        { reason: "oauth_affinity_unavailable" },
      );
    }
    if (stickyOnly && knownSticky) {
      const source = affinityKeySource(stickyKey ?? null) ?? "stateful continuation";
      throw new CodexResponsesBeforeSendError(
        `oauth pool: ${source} original account is unavailable`,
        { reason: "oauth_affinity_unavailable" },
      );
    }
    const { entry: best, reason } = chooseByStrategy(
      capacityTier.candidates,
      stickyOnly ? null : (stickyKey ?? null),
      stickyEntry,
      model,
      nowMs,
    );
    if (!best) {
      if (model !== null && !entries.some((entry) => supportsModel(entry.member, model, nowMs))) {
        throw new Error(`oauth pool: no account supports model "${model}"`);
      }
      throw new Error("oauth pool has no schedulable account");
    }
    return commitSelection(best, stickyOnly ? null : (stickyKey ?? null), nowMs, {
      ...selectionBase,
      reason,
    });
  }

  function forgetStickyAccount(account: string, preservePreviousResponses = false): void {
    for (const [key, sticky] of stickySessions) {
      if (
        sticky.account === account &&
        !(preservePreviousResponses && isStrictAccountSticky(key))
      ) {
        stickySessions.delete(key);
      }
    }
  }

  function parkCredentialFailedAccount(entry: PoolEntry, err: unknown): void {
    entry.member.schedulable = false;
    forgetStickyAccount(entry.member.account, true);
    if (credentialFailureReported.has(entry.member.account)) return;
    credentialFailureReported.add(entry.member.account);
    try {
      deps.onAccountCredentialFailure?.(entry.member.account, err);
    } catch {
      /* fail-open: persistence hooks must not break in-pool failover */
    }
  }

  function coolRetryableAccount(entry: PoolEntry): void {
    retryableAccountFailures.set(
      entry.member.account,
      now() + RETRYABLE_ACCOUNT_FAILURE_COOLDOWN_MS,
    );
    forgetStickyAccount(entry.member.account, true);
  }

  function rateLimitScope(
    entry: PoolEntry,
    err: unknown,
    model: string | null,
  ): OAuthRateLimitScope {
    const context = { account: entry.member.account, model, error: err };
    try {
      const resolved = deps.resolveRateLimitScope?.(context);
      if (resolved?.scope === "model" && resolved.model.length > 0) return resolved;
      if (resolved?.scope === "account") return resolved;
      if (deps.shouldParkRateLimit?.(context) === false && model !== null) {
        return { scope: "model", model, limitId: null };
      }
      return { scope: "account" };
    } catch {
      return { scope: "account" };
    }
  }

  function parkRateLimitedAccount(entry: PoolEntry, err: unknown, model: string | null): void {
    const scope = rateLimitScope(entry, err, model);
    if (scope.scope === "model") {
      const key = scopedRateLimitKey(entry.member.account, scope.model, scope.limitId);
      const candidate = now() + accountRateLimitCooldownMs;
      const current = scopedRateLimits.get(key);
      scopedRateLimits.set(key, {
        account: entry.member.account,
        model: scope.model,
        limitId: scope.limitId,
        untilMs: current && current.untilMs > candidate ? current.untilMs : candidate,
      });
      forgetStickyAccount(entry.member.account, true);
      return;
    }
    const candidate = now() + accountRateLimitCooldownMs;
    // Extend-only: a precise upstream quota reset (e.g. a Codex weekly limit, captured
    // from response headers before the 429 threw) may already sit far in the future —
    // the generic short fallback must never pull it back in. Propagate the kept value to
    // the hook so the persisted snapshot is not shortened either.
    const current = entry.member.usageLimitedUntilMs;
    const untilMs = current != null && current > candidate ? current : candidate;
    entry.member.usageLimitedUntilMs = untilMs;
    forgetStickyAccount(entry.member.account, true);
    try {
      deps.onAccountRateLimit?.(entry.member.account, untilMs);
    } catch {
      /* fail-open: persistence/telemetry hooks must not break in-pool failover */
    }
  }

  // Non-stream in-pool retry: try the selected account; on a transient pre-result fault
  // advance to the next eligible sibling, until one succeeds or none remain. When the
  // pool is exhausted we surface the LAST upstream fault (the real cause), not the
  // internal "no schedulable account" — the executor records THAT and advances the chain.
  async function completeWithRetry<R>(
    stickyKey: string | null,
    model: string | null,
    avoidBusy: boolean,
    call: (client: ProviderClient, entry: PoolEntry) => Promise<R>,
    credentialFailureStatuses = upstreamCredentialFailureStatuses,
    retryForbiddenWithoutParking = false,
  ): Promise<R> {
    const tried = new Set<string>();
    const statefulContinuation = isStrictAccountSticky(stickyKey);
    let lastErr: unknown;
    for (;;) {
      let entry: PoolEntry;
      try {
        entry = select(stickyKey, tried, { avoidBusy, model });
      } catch (selErr) {
        throw lastErr ?? selErr;
      }
      tried.add(entry.member.account);
      try {
        const result = await call(entry.member.client, entry);
        if (stickyKey?.startsWith("previous_response_id:")) {
          rememberSticky(stickyKey, entry.member.account, now() + stickyTtlMs);
        }
        rememberResponseAffinity(result, entry);
        return result;
      } catch (err) {
        if (isRetryableAccountFailure(err)) {
          coolRetryableAccount(entry);
          if (statefulContinuation) throw err;
          lastErr = err;
          continue;
        }
        if (isCredentialAccountFailure(err, credentialFailureStatuses)) {
          parkCredentialFailedAccount(entry, err);
          if (statefulContinuation) throw err;
          lastErr = err;
          continue;
        }
        if (
          retryForbiddenWithoutParking &&
          err instanceof UpstreamError &&
          err.upstreamStatus === 403
        ) {
          lastErr = err;
          continue;
        }
        if (isRateLimitAccountFailure(err)) {
          parkRateLimitedAccount(entry, err, model);
          if (statefulContinuation) throw err;
          lastErr = err;
          continue;
        }
        if (isAccountBackpressureFailure(err)) {
          if (statefulContinuation) throw err;
          lastErr = err;
          continue;
        }
        if (!isRetryableTransientError(err)) throw err;
        if (statefulContinuation) throw err;
        lastErr = err;
      }
    }
  }

  // Streaming in-pool retry. The FIRST account is picked SYNCHRONOUSLY on the call turn
  // (preserving rotation + onSelect timing — a lazy iterable that deferred select() would
  // skip rotation until drained); `firstEntry` is that pick. Retry only happens BEFORE the
  // first chunk: once a chunk is yielded the account is committed (its bytes are already on
  // the wire), so a mid-stream fault propagates and is NEVER retried.
  async function* streamWithRetry(
    firstEntry: PoolEntry,
    stickyKey: string | null,
    model: string | null,
    avoidBusy: boolean,
    open: (client: ProviderClient, entry: PoolEntry) => AsyncIterable<string>,
    // When set, each member's SSE is wrapped so a pre-output error frame (after only a
    // content-free preamble) throws BEFORE the first yielded chunk — turning "commit on
    // first raw chunk" into "commit on first real output", so the in-band failure fails
    // over to a sibling account instead of committing the doomed stream.
    preambleClassifier?: PreOutputClassifier | null,
  ): AsyncIterable<string> {
    const tried = new Set<string>([firstEntry.member.account]);
    const statefulContinuation = isStrictAccountSticky(stickyKey);
    let entry = firstEntry;
    let lastErr: unknown;
    for (;;) {
      let iterator: AsyncIterator<string> | undefined;
      let first: IteratorResult<string>;
      try {
        const raw = open(entry.member.client, entry);
        iterator = (preambleClassifier ? guardPreOutputFailure(raw, preambleClassifier) : raw)[
          Symbol.asyncIterator
        ]();
        first = await iterator.next(); // pre-first-(real-)chunk fault surfaces HERE
      } catch (err) {
        if (iterator) await iterator.return?.().catch(() => {});
        const invalidPreviousResponseId = isInvalidPreviousResponseIdFailure(stickyKey, err);
        if (isRetryableAccountFailure(err)) {
          coolRetryableAccount(entry);
          lastErr = err;
        } else if (isCredentialAccountFailure(err, upstreamCredentialFailureStatuses)) {
          parkCredentialFailedAccount(entry, err);
          lastErr = err;
        } else if (isRateLimitAccountFailure(err)) {
          parkRateLimitedAccount(entry, err, model);
          lastErr = err;
        } else if (isAccountBackpressureFailure(err)) {
          lastErr = err;
        } else {
          if (!isRetryableTransientError(err)) throw err;
          lastErr = err;
        }
        if (statefulContinuation && !invalidPreviousResponseId) throw lastErr;
        let next: PoolEntry;
        try {
          next = select(stickyKey, tried, { avoidBusy, model });
        } catch {
          throw lastErr; // no sibling left → surface the real upstream cause
        }
        tried.add(next.member.account);
        entry = next;
        continue;
      }
      // First chunk obtained (or a clean empty stream) → COMMIT to this account.
      if (stickyKey?.startsWith("previous_response_id:")) {
        rememberSticky(stickyKey, entry.member.account, now() + stickyTtlMs);
      }
      if (stickyKey?.startsWith("responses_websocket_session:")) {
        rememberSticky(stickyKey, entry.member.account, now() + stickyTtlMs);
      }
      const trackResponseAffinity = streamResponseAffinityTracker(entry);
      try {
        if (!first.done) {
          trackResponseAffinity(first.value);
          yield first.value;
        }
        while (true) {
          const chunk = await iterator.next();
          if (chunk.done) return;
          trackResponseAffinity(chunk.value);
          yield chunk.value;
        }
      } finally {
        await iterator.return?.().catch(() => {});
      }
    }
  }

  return {
    ...(nativeProtocolProfile === undefined ? {} : { nativeProtocolProfile }),
    hasAvailableModel(model: string): boolean {
      const nowMs = now();
      return entries.some(
        (entry) => entry.member.schedulable && supportsModel(entry.member, model, nowMs),
      );
    },
    // Park / un-park ONE account's auto-park cooldown in place. The next select()
    // observes the new value without a pool rebuild; null clears it (the manual
    // "Reset usage" path). Unknown account = no-op.
    setUsageLimit(account: string, untilMs: number | null): void {
      const entry = entries.find((e) => e.member.account === account);
      if (entry) entry.member.usageLimitedUntilMs = untilMs;
      if (untilMs === null) {
        retryableAccountFailures.delete(account);
        for (const [key, cooldown] of scopedRateLimits) {
          if (cooldown.account === account) scopedRateLimits.delete(key);
        }
      }
    },
    seedUsageLimit(account: string, untilMs: number | null): void {
      const entry = entries.find((e) => e.member.account === account);
      if (entry) entry.member.usageLimitedUntilMs = untilMs;
    },
    getUsageLimit(account: string): number | null {
      return entries.find((e) => e.member.account === account)?.member.usageLimitedUntilMs ?? null;
    },
    setQuotaSnapshot(
      account: string,
      windows: OAuthQuotaWindow[],
      capturedAtMs: number,
      resetCredits?: number | null,
    ): void {
      const entry = entries.find((e) => e.member.account === account);
      if (!entry) return;
      entry.member.quotaWindows = windows;
      entry.member.quotaCapturedAtMs = capturedAtMs;
      if (resetCredits !== undefined) entry.member.quotaResetCredits = resetCredits;
    },
    async chatCompletion(
      req: ChatCompletionRequest,
      opts?: ProviderCallOptions,
    ): Promise<ChatCompletionResponse> {
      const stickyKey = stickyKeyFromChat(req);
      restorePersistedAffinity(stickyKey, opts?.statefulAccount);
      return completeWithRetry(
        stickyKey,
        modelFromChat(req),
        isUserMessageRequest(req),
        (client, entry) => client.chatCompletion(req, callOptionsForEntry(opts, entry)),
      );
    },
    chatCompletionStream(
      req: ChatCompletionRequest,
      opts?: ProviderCallOptions,
    ): AsyncIterable<string> {
      // Pick SYNCHRONOUSLY (one pick per call) before opening the stream so rotation +
      // onSelect fire on the call turn; streamWithRetry only adds sibling fallbacks.
      const stickyKey = stickyKeyFromChat(req);
      restorePersistedAffinity(stickyKey, opts?.statefulAccount);
      const avoidBusy = isUserMessageRequest(req);
      const first = select(stickyKey, undefined, { avoidBusy, model: modelFromChat(req) });
      return streamWithRetry(
        first,
        stickyKey,
        modelFromChat(req),
        avoidBusy,
        (client, entry) => client.chatCompletionStream(req, callOptionsForEntry(opts, entry)),
        deps.chatStreamPreambleClassifier,
      );
    },
    // Native protocol passthrough (issue #217, Phase 1): forward it like the other
    // methods so the executor's feature-detect (`provider.nativePassthrough`) sees a
    // real method on a subscription alias — otherwise the branch could never fire.
    // Select FIRST (rotation + onSelect), then delegate to the picked member. If that
    // member's client has no nativePassthrough, throw fail-closed (principle 2): never
    // silently route to a translating sibling — the executor records the failure and
    // advances the chain. The `nativePassthrough` member is also wired ONLY when the
    // whole pool's provider speaks the same native protocol, so a missing method here
    // signals a real wiring fault, not a normal heterogeneous-chain case.
    async nativePassthrough(
      body: NativePassthroughInput,
      opts?: ProviderCallOptions,
    ): Promise<ChatCompletionResponse> {
      // completeWithRetry's first select() runs SYNCHRONOUSLY before its first await, so
      // rotation + onSelect fire on the call turn exactly like the other methods. A member
      // missing the method throws a NON-transient error → surfaced at once (fail-closed,
      // never silently routed to a translating sibling), not retried.
      const stickyKey = stickyKeyFromNative(body);
      restorePersistedAffinity(stickyKey, opts?.statefulAccount);
      return completeWithRetry(
        stickyKey,
        modelFromNative(body),
        isUserMessageRequest(nativePassthroughBody(body)),
        (client, entry) => {
          if (!client.nativePassthrough) {
            throw new Error("oauth pool member does not support native passthrough");
          }
          return client.nativePassthrough(body, callOptionsForEntry(opts, entry));
        },
      );
    },
    // Streaming native passthrough (issue #217, Phase 2). A SYNCHRONOUS method (NOT an
    // async fn) so select() — and thus rotation + onSelect — fires on the CALL turn,
    // exactly like chatCompletionStream: the returned value is a lazy async iterable, so
    // deferring select() into an async body would skip rotation until the consumer drains.
    // Fail-closed (principle 2) if the picked member lacks the method, on the call turn.
    nativePassthroughStream(
      body: NativePassthroughInput,
      opts?: ProviderCallOptions,
    ): AsyncIterable<string> {
      const stickyKey = stickyKeyFromNative(body);
      restorePersistedAffinity(stickyKey, opts?.statefulAccount);
      const avoidBusy = isUserMessageRequest(nativePassthroughBody(body));
      // Pick + fail-closed check SYNCHRONOUSLY on the call turn (rotation + onSelect, and a
      // synchronous throw if the picked member can't passthrough-stream), exactly as before.
      const first = select(stickyKey, undefined, { avoidBusy, model: modelFromNative(body) });
      if (!first.member.client.nativePassthroughStream) {
        throw new Error("oauth pool member does not support native passthrough streaming");
      }
      return streamWithRetry(
        first,
        stickyKey,
        modelFromNative(body),
        avoidBusy,
        (client, entry) => {
          if (!client.nativePassthroughStream) {
            throw new Error("oauth pool member does not support native passthrough streaming");
          }
          return client.nativePassthroughStream(body, callOptionsForEntry(opts, entry));
        },
        deps.nativeStreamPreambleClassifier,
      );
    },
    ...(entries.length > 0 &&
    entries.every((entry) => typeof entry.member.client.realtimeCall === "function")
      ? {
          async realtimeCall(
            req: RealtimeCallRequest,
            opts?: ProviderCallOptions,
          ): Promise<RealtimeCallResult> {
            // Realtime models are selected by the voice endpoint, not the Codex
            // text-model catalog used for per-account entitlement filtering.
            return completeWithRetry(
              null,
              null,
              false,
              (client, entry) => {
                if (!client.realtimeCall) {
                  throw new Error("oauth pool member does not support Realtime calls");
                }
                return client.realtimeCall(req, callOptionsForEntry(opts, entry)).then((result) => {
                  const target = result.sideband;
                  return {
                    ...result,
                    sideband: {
                      ...target,
                      headers: async () => {
                        try {
                          return await target.headers();
                        } catch (error) {
                          if (isCredentialAccountFailure(error, new Set([401]))) {
                            parkCredentialFailedAccount(entry, error);
                          }
                          throw error;
                        }
                      },
                      onCredentialFailure: (status: number) => {
                        target.onCredentialFailure?.(status);
                        if (status === 401) {
                          parkCredentialFailedAccount(
                            entry,
                            new UpstreamError(
                              "upstream_error",
                              "realtime sideband authentication failed",
                              null,
                              status,
                            ),
                          );
                        }
                      },
                    },
                  };
                });
              },
              new Set([401]),
              true,
            );
          },
        }
      : {}),
    ...(entries.length > 0 &&
    entries.every((entry) => typeof entry.member.client.responsesCompact === "function")
      ? {
          async responsesCompact(
            req: NativePassthroughInput,
            opts?: ProviderCallOptions,
          ): Promise<Record<string, unknown>> {
            const stickyKey = stickyKeyFromNative(req);
            restorePersistedAffinity(stickyKey, opts?.statefulAccount);
            return completeWithRetry(
              stickyKey,
              modelFromNative(req),
              isUserMessageRequest(nativePassthroughBody(req)),
              (client, entry) => {
                if (!client.responsesCompact) {
                  throw new Error("oauth pool member does not support Responses compact");
                }
                return client.responsesCompact(req, callOptionsForEntry(opts, entry));
              },
            );
          },
        }
      : {}),
    ...(entries.length > 0 &&
    entries.every((entry) => typeof entry.member.client.imageGeneration === "function")
      ? {
          async imageGeneration(
            req: Record<string, unknown>,
            opts?: ProviderCallOptions,
          ): Promise<Record<string, unknown>> {
            // Image generation is a paid write. One selected account gets one
            // upstream attempt; an ambiguous result must never rotate to a sibling.
            const entry = select(null, undefined, { model: mediaModel(req) });
            if (!entry.member.client.imageGeneration) {
              throw new Error("oauth pool member does not support image generation");
            }
            await opts?.onAccountSelected?.(entry.member.account);
            return entry.member.client.imageGeneration(req, callOptionsForEntry(opts, entry));
          },
        }
      : {}),
    ...(entries.length > 0 &&
    entries.every((entry) => typeof entry.member.client.imageEdit === "function")
      ? {
          async imageEdit(req, opts?: ProviderCallOptions): Promise<Record<string, unknown>> {
            // Same single-write rule as image generation; image edits can create a
            // billable asset and cannot be safely replayed through another account.
            const entry = select(null, undefined, { model: imageEditModel(req) });
            if (!entry.member.client.imageEdit) {
              throw new Error("oauth pool member does not support image editing");
            }
            await opts?.onAccountSelected?.(entry.member.account);
            return entry.member.client.imageEdit(req, callOptionsForEntry(opts, entry));
          },
        }
      : {}),
    ...(entries.length > 0 &&
    entries.every((entry) => typeof entry.member.client.videoGeneration === "function")
      ? {
          async videoGeneration(
            req: Record<string, unknown>,
            opts?: ProviderCallOptions,
          ): Promise<Record<string, unknown>> {
            // Video creation is also a single write: no in-pool retry, cooldown, or
            // sibling failover after an upstream attempt has started.
            const entry = select(null, undefined, { model: mediaModel(req) });
            if (!entry.member.client.videoGeneration) {
              throw new Error("oauth pool member does not support video generation");
            }
            await opts?.onAccountSelected?.(entry.member.account);
            return entry.member.client.videoGeneration(req, callOptionsForEntry(opts, entry));
          },
        }
      : {}),
    ...(entries.length > 0 &&
    entries.every((entry) => typeof entry.member.client.videoExtension === "function")
      ? {
          async videoExtension(
            req: Record<string, unknown>,
            opts?: ProviderCallOptions,
          ): Promise<Record<string, unknown>> {
            const entry = select(null, undefined, { model: mediaModel(req) });
            if (!entry.member.client.videoExtension) {
              throw new Error("oauth pool member does not support video extension");
            }
            await opts?.onAccountSelected?.(entry.member.account);
            return entry.member.client.videoExtension(req, callOptionsForEntry(opts, entry));
          },
        }
      : {}),
    ...(entries.length > 0 &&
    entries.every((entry) => typeof entry.member.client.videoRetrieve === "function")
      ? {
          async videoRetrieve(
            requestId: string,
            opts?: ProviderCallOptions,
          ): Promise<Record<string, unknown>> {
            // The registry's persisted provider account is authoritative for a poll.
            // Restore it as a strict sticky target: if unavailable, fail closed rather
            // than revealing or polling the same upstream task through a sibling.
            const providerAccount = opts?.providerAccount ?? opts?.statefulAccount;
            const stickyKey = providerAccount ? `provider_account:${providerAccount}` : null;
            restorePersistedAffinity(stickyKey, providerAccount);
            return completeWithRetry(stickyKey, null, false, (client, entry) => {
              if (!client.videoRetrieve) {
                throw new Error("oauth pool member does not support video retrieval");
              }
              return client.videoRetrieve(requestId, callOptionsForEntry(opts, entry));
            });
          },
        }
      : {}),
    async closeResponsesWebSocketSession(sessionId: string): Promise<void> {
      stickySessions.delete(`responses_websocket_session:${sessionId}`);
      await Promise.all(
        entries.map(
          (entry) =>
            entry.member.client.closeResponsesWebSocketSession?.(sessionId) ?? Promise.resolve(),
        ),
      );
    },
  };
}
