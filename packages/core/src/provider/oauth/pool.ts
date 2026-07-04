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
} from "@helm/shared";
import { isUserMessageRequest } from "../../queue/user-turn.js";
import { guardPreOutputFailure, type PreOutputClassifier } from "../failover-guard.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderClient,
  UpstreamError,
} from "../openai.js";
import { TokenRefreshError } from "../token-manager.js";
import { DEFAULT_429_COOLDOWN_MS } from "./usage-limit.js";

// Which PRE-FIRST-CHUNK failure justifies trying a SIBLING account in the same pool
// before the executor advances to the next alias. A Codex (openai_responses + native
// tools) request has NO valid cross-protocol fallback — every non-Responses alias is
// skipped — so the only real fallback is another account of the SAME subscription. We
// retry only TRANSIENT, account-agnostic server faults (a 5xx / overload / connect
// timeout on one account says nothing about its siblings) and DELIBERATELY exclude
// deterministic request-shape 4xx (400/413/422) — a sibling would hit those
// identically, so surface them immediately for executor classification. Account-local
// OAuth 401/403/429 is handled by the dedicated helpers below, because those statuses
// say something about the selected subscription account, not about the model alias.
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
function isCredentialAccountFailure(err: unknown): boolean {
  if (err instanceof TokenRefreshError) {
    const status = err.httpStatus;
    return status === 400 || status === 401 || status === 403;
  }
  if (err instanceof UpstreamError) {
    return err.upstreamStatus === 401 || err.upstreamStatus === 403;
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
}

// The pool's ProviderClient plus an out-of-band mutator the gateway uses to park /
// un-park a single account in O(1) — a single 429 must NOT rebuild the whole pool
// (which re-refreshes every token). `setUsageLimit` on an unknown account is a no-op
// (the member may have been dropped by a concurrent rebuild).
export interface OAuthPoolClient extends ProviderClient {
  setUsageLimit(account: string, untilMs: number | null): void;
  // The account's current auto-park cooldown (epoch ms), or null if eligible now. Lets
  // the gateway make a park EXTEND-ONLY — never shorten a precise quota reset already set.
  getUsageLimit(account: string): number | null;
}

export interface OAuthRateLimitParkContext {
  account: string;
  model: string | null;
  error: unknown;
}

export interface OAuthPoolDeps {
  members: OAuthPoolMember[];
  // Injected clock (default Date.now) so the LRU cursor is testable.
  now?: () => number;
  // Native CLI safety: bind repeated requests with the same client/session
  // fingerprint to the same OAuth account for this TTL.
  stickyTtlMs?: number;
  // Fires with the selected account on each served call — the seam the gateway
  // uses to record the serving subscription in telemetry / logs (no secrets).
  onSelect?: (account: string, selection: OAuthPoolSelection) => void;
  // Fires when the selected account hits an account-wide upstream 429. The pool already
  // applies the in-memory cooldown before calling this; the hook lets the gateway persist
  // the same cooldown so rebuilds/restarts keep routing around the account.
  onAccountRateLimit?: (account: string, untilMs: number) => void;
  accountRateLimitCooldownMs?: number;
  // Optional model-aware guard for provider-specific scoped caps. Returning false
  // means "retry a sibling for this request, but do not globally park the account".
  shouldParkRateLimit?: (ctx: OAuthRateLimitParkContext) => boolean;
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
  reason: "sticky_hit" | "hash_assign" | "lru";
  affinityKeySource: string | null;
  capacityAvoided: boolean;
  allCandidatesAtCapacity: boolean;
  busyEligibleAccounts: number;
  retryAttempt: number;
}

export function createOAuthPoolClient(deps: OAuthPoolDeps): OAuthPoolClient {
  const now = deps.now ?? (() => Date.now());
  const stickyTtlMs = deps.stickyTtlMs ?? 10 * 60 * 1000;
  const accountRateLimitCooldownMs = deps.accountRateLimitCooldownMs ?? DEFAULT_429_COOLDOWN_MS;
  const entries: PoolEntry[] = deps.members.map((member) => ({ member, lastUsedAt: 0 }));
  const stickySessions = new Map<string, { account: string; expiresAt: number }>();
  let selectionCounter = 0;

  // An account is eligible only when the operator has not parked it (`schedulable`)
  // AND its auto-park cooldown has elapsed. Re-evaluated on every select() against the
  // live clock, so a cooldown un-parks itself the instant `now` passes it.
  function usageLimited(member: OAuthPoolMember, nowMs: number): boolean {
    const until = member.usageLimitedUntilMs;
    return until != null && nowMs < until;
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
    const bodyDeviceKey = deviceAffinityKeyFromBody(body);
    if (bodyDeviceKey !== null) return bodyDeviceKey;
    if (isNativePassthroughCarrier(input)) {
      for (const header of ["device_id", "x-device-id"]) {
        const value = headerValue(input.headers, header);
        if (value !== null) return `${header}:${value}`;
      }
      for (const header of ["session_id", "x-session-id", "prompt_cache_key", "conversation_id"]) {
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
    const previousResponseId = bodyString(body, "previous_response_id");
    if (previousResponseId !== null) return `previous_response_id:${previousResponseId}`;
    return null;
  }

  function stickyKeyFromChat(req: ChatCompletionRequest): string | null {
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
    const previousResponseId = bodyString(req, "previous_response_id");
    if (previousResponseId !== null) return `previous_response_id:${previousResponseId}`;
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

  function eligibleEntries(nowMs: number, exclude: ReadonlySet<string> | undefined): PoolEntry[] {
    return entries.filter(
      (e) =>
        e.member.schedulable && !usageLimited(e.member, nowMs) && !exclude?.has(e.member.account),
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
    stickySessions.set(`previous_response_id:${id}`, {
      account: entry.member.account,
      expiresAt: now() + stickyTtlMs,
    });
  }

  function affinityKeySource(stickyKey: string | null): string | null {
    if (stickyKey === null) return null;
    const separator = stickyKey.indexOf(":");
    return separator > 0 ? stickyKey.slice(0, separator) : "unknown";
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
      stickySessions.set(stickyKey, {
        account: entry.member.account,
        expiresAt: nowMs + stickyTtlMs,
      });
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
    opts: { avoidBusy?: boolean } = {},
  ): PoolEntry {
    const nowMs = now();
    const eligible = eligibleEntries(nowMs, exclude);
    const capacityTier = preferredCapacityTier(eligible, opts.avoidBusy === true);
    const selectionBase = {
      affinityKeySource: affinityKeySource(stickyKey ?? null),
      capacityAvoided: capacityTier.capacityAvoided,
      allCandidatesAtCapacity: capacityTier.allCandidatesAtCapacity,
      busyEligibleAccounts: capacityTier.busyEligibleAccounts,
      retryAttempt: exclude?.size ?? 0,
    };
    if (stickyKey) {
      const sticky = stickySessions.get(stickyKey);
      if (sticky !== undefined && sticky.expiresAt > nowMs) {
        const entry = capacityTier.candidates.find(
          (candidate) => candidate.member.account === sticky.account,
        );
        if (entry !== undefined) {
          sticky.expiresAt = nowMs + stickyTtlMs;
          return commitSelection(entry, stickyKey, nowMs, {
            ...selectionBase,
            reason: "sticky_hit",
          });
        }
      }
      stickySessions.delete(stickyKey);
    }

    const stickyOnly = stickyKey?.startsWith("previous_response_id:") === true;
    const best =
      stickyKey && !stickyOnly && capacityTier.candidates.length > 0
        ? chooseByStickyHash(capacityTier.candidates, stickyKey)
        : chooseByLru(capacityTier.candidates);
    if (!best) throw new Error("oauth pool has no schedulable account");
    return commitSelection(best, stickyOnly ? null : (stickyKey ?? null), nowMs, {
      ...selectionBase,
      reason: stickyKey && !stickyOnly ? "hash_assign" : "lru",
    });
  }

  function forgetStickyAccount(account: string): void {
    for (const [key, sticky] of stickySessions) {
      if (sticky.account === account) stickySessions.delete(key);
    }
  }

  function parkCredentialFailedAccount(entry: PoolEntry): void {
    entry.member.schedulable = false;
    forgetStickyAccount(entry.member.account);
  }

  function shouldParkRateLimitedAccount(
    entry: PoolEntry,
    err: unknown,
    model: string | null,
  ): boolean {
    try {
      return (
        deps.shouldParkRateLimit?.({ account: entry.member.account, model, error: err }) ?? true
      );
    } catch {
      return true;
    }
  }

  function parkRateLimitedAccount(entry: PoolEntry, err: unknown, model: string | null): void {
    if (!shouldParkRateLimitedAccount(entry, err, model)) {
      forgetStickyAccount(entry.member.account);
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
    forgetStickyAccount(entry.member.account);
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
    call: (client: ProviderClient) => Promise<R>,
  ): Promise<R> {
    const tried = new Set<string>();
    let lastErr: unknown;
    for (;;) {
      let entry: PoolEntry;
      try {
        entry = select(stickyKey, tried, { avoidBusy });
      } catch (selErr) {
        throw lastErr ?? selErr;
      }
      tried.add(entry.member.account);
      try {
        const result = await call(entry.member.client);
        rememberResponseAffinity(result, entry);
        return result;
      } catch (err) {
        if (isCredentialAccountFailure(err)) {
          parkCredentialFailedAccount(entry);
          lastErr = err;
          continue;
        }
        if (isRateLimitAccountFailure(err)) {
          parkRateLimitedAccount(entry, err, model);
          lastErr = err;
          continue;
        }
        if (isAccountBackpressureFailure(err)) {
          lastErr = err;
          continue;
        }
        if (!isRetryableTransientError(err)) throw err;
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
    open: (client: ProviderClient) => AsyncIterable<string>,
    // When set, each member's SSE is wrapped so a pre-output error frame (after only a
    // content-free preamble) throws BEFORE the first yielded chunk — turning "commit on
    // first raw chunk" into "commit on first real output", so the in-band failure fails
    // over to a sibling account instead of committing the doomed stream.
    preambleClassifier?: PreOutputClassifier | null,
  ): AsyncIterable<string> {
    const tried = new Set<string>([firstEntry.member.account]);
    let entry = firstEntry;
    let lastErr: unknown;
    for (;;) {
      let iterator: AsyncIterator<string> | undefined;
      let first: IteratorResult<string>;
      try {
        const raw = open(entry.member.client);
        iterator = (preambleClassifier ? guardPreOutputFailure(raw, preambleClassifier) : raw)[
          Symbol.asyncIterator
        ]();
        first = await iterator.next(); // pre-first-(real-)chunk fault surfaces HERE
      } catch (err) {
        if (iterator) await iterator.return?.().catch(() => {});
        if (isCredentialAccountFailure(err)) {
          parkCredentialFailedAccount(entry);
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
        let next: PoolEntry;
        try {
          next = select(stickyKey, tried, { avoidBusy });
        } catch {
          throw lastErr; // no sibling left → surface the real upstream cause
        }
        tried.add(next.member.account);
        entry = next;
        continue;
      }
      // First chunk obtained (or a clean empty stream) → COMMIT to this account.
      try {
        if (!first.done) yield first.value;
        while (true) {
          const chunk = await iterator.next();
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally {
        await iterator.return?.().catch(() => {});
      }
    }
  }

  return {
    // Park / un-park ONE account's auto-park cooldown in place. The next select()
    // observes the new value without a pool rebuild; null clears it (the manual
    // "Reset usage" path). Unknown account = no-op.
    setUsageLimit(account: string, untilMs: number | null): void {
      const entry = entries.find((e) => e.member.account === account);
      if (entry) entry.member.usageLimitedUntilMs = untilMs;
    },
    getUsageLimit(account: string): number | null {
      return entries.find((e) => e.member.account === account)?.member.usageLimitedUntilMs ?? null;
    },
    async chatCompletion(
      req: ChatCompletionRequest,
      opts?: { signal?: AbortSignal },
    ): Promise<ChatCompletionResponse> {
      return completeWithRetry(
        stickyKeyFromChat(req),
        modelFromChat(req),
        isUserMessageRequest(req),
        (client) => client.chatCompletion(req, opts),
      );
    },
    chatCompletionStream(
      req: ChatCompletionRequest,
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<string> {
      // Pick SYNCHRONOUSLY (one pick per call) before opening the stream so rotation +
      // onSelect fire on the call turn; streamWithRetry only adds sibling fallbacks.
      const stickyKey = stickyKeyFromChat(req);
      const avoidBusy = isUserMessageRequest(req);
      const first = select(stickyKey, undefined, { avoidBusy });
      return streamWithRetry(
        first,
        stickyKey,
        modelFromChat(req),
        avoidBusy,
        (client) => client.chatCompletionStream(req, opts),
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
      opts?: { signal?: AbortSignal },
    ): Promise<ChatCompletionResponse> {
      // completeWithRetry's first select() runs SYNCHRONOUSLY before its first await, so
      // rotation + onSelect fire on the call turn exactly like the other methods. A member
      // missing the method throws a NON-transient error → surfaced at once (fail-closed,
      // never silently routed to a translating sibling), not retried.
      return completeWithRetry(
        stickyKeyFromNative(body),
        modelFromNative(body),
        isUserMessageRequest(nativePassthroughBody(body)),
        (client) => {
          if (!client.nativePassthrough) {
            throw new Error("oauth pool member does not support native passthrough");
          }
          return client.nativePassthrough(body, opts);
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
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<string> {
      const stickyKey = stickyKeyFromNative(body);
      const avoidBusy = isUserMessageRequest(nativePassthroughBody(body));
      // Pick + fail-closed check SYNCHRONOUSLY on the call turn (rotation + onSelect, and a
      // synchronous throw if the picked member can't passthrough-stream), exactly as before.
      const first = select(stickyKey, undefined, { avoidBusy });
      if (!first.member.client.nativePassthroughStream) {
        throw new Error("oauth pool member does not support native passthrough streaming");
      }
      return streamWithRetry(
        first,
        stickyKey,
        modelFromNative(body),
        avoidBusy,
        (client) => {
          if (!client.nativePassthroughStream) {
            throw new Error("oauth pool member does not support native passthrough streaming");
          }
          return client.nativePassthroughStream(body, opts);
        },
        deps.nativeStreamPreambleClassifier,
      );
    },
  };
}
