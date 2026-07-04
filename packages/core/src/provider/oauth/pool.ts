// OAuth account POOL client (issue #38, Stage 3). A single ProviderClient that
// fronts N per-account clients of ONE subscription provider (each already built
// with its own token manager + egress proxy + executor type). On every call it
// SELECTS one account, then delegates the whole request to that account's client.
//
// Selection (CRS-reference scheduler): from the SCHEDULABLE members, pick the one
// with the lowest `priority` (lower = preferred); ties broken by least-recently-
// used (oldest `lastUsedAt` first), giving round-robin within an equal priority.
// The chosen member's `lastUsedAt` is bumped (in-memory) so the next call rotates
// to its sibling. `onSelect(account)` fires with the picked account so the caller
// can record WHICH subscription served the request (telemetry / structured log).
//
// Fail-closed (principle 2): a pool with no schedulable member cannot serve, so
// the call throws — the executor records the failure and advances the chain, never
// silently picks a parked account. Streaming and non-streaming share the SAME
// selection (one pick per call), so a streamed request also rotates the pool.

import {
  isNativePassthroughCarrier,
  type NativePassthroughInput,
  nativePassthroughBody,
} from "@helm/shared";
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

// One account in the pool: its scheduling knobs plus the fully-wired client that
// carries that account's credential + proxy. `lastUsedAt` is MUTABLE soft state
// (round-robin cursor); it starts at 0 so an untouched account is always preferred
// over one that has already served.
export interface OAuthPoolMember {
  account: string;
  priority: number;
  schedulable: boolean;
  client: ProviderClient;
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
  onSelect?: (account: string) => void;
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

export function createOAuthPoolClient(deps: OAuthPoolDeps): OAuthPoolClient {
  const now = deps.now ?? (() => Date.now());
  const stickyTtlMs = deps.stickyTtlMs ?? 10 * 60 * 1000;
  const accountRateLimitCooldownMs = deps.accountRateLimitCooldownMs ?? DEFAULT_429_COOLDOWN_MS;
  const entries: PoolEntry[] = deps.members.map((member) => ({ member, lastUsedAt: 0 }));
  const stickySessions = new Map<string, { account: string; expiresAt: number }>();

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

  function stickyKeyFromNative(input: NativePassthroughInput): string | null {
    const body = nativePassthroughBody(input);
    if (isNativePassthroughCarrier(input)) {
      for (const header of [
        "session_id",
        "x-session-id",
        "x-client-request-id",
        "prompt_cache_key",
        "conversation_id",
      ]) {
        const value = headerValue(input.headers, header);
        if (value !== null) return `${header}:${value}`;
      }
    }
    for (const key of [
      "session_id",
      "prompt_cache_key",
      "conversation_id",
      "previous_response_id",
    ]) {
      const value = bodyString(body, key);
      if (value !== null) return `${key}:${value}`;
    }
    const metadata = body.metadata;
    if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
      for (const key of ["session_id", "conversation_id", "thread_id"]) {
        const value = bodyString(metadata as Record<string, unknown>, key);
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

  // Pick the next account: lowest priority, then oldest lastUsedAt (LRU round-
  // robin within equal priority). Bumps the winner's cursor and notifies onSelect.
  // Throws when no member is schedulable (fail-closed — the caller treats it as a
  // provider failure and advances the fallback chain).
  // `exclude` holds accounts already TRIED-and-transiently-failed this request (in-pool
  // retry): they are skipped — both as the sticky target and in the LRU scan — so each
  // retry advances to a fresh sibling and the loop terminates (bounded by member count).
  function select(stickyKey?: string | null, exclude?: ReadonlySet<string>): PoolEntry {
    const nowMs = now();
    if (stickyKey) {
      const sticky = stickySessions.get(stickyKey);
      if (sticky !== undefined && sticky.expiresAt > nowMs) {
        const entry = entries.find(
          (candidate) =>
            candidate.member.account === sticky.account &&
            candidate.member.schedulable &&
            !usageLimited(candidate.member, nowMs) &&
            !exclude?.has(candidate.member.account),
        );
        if (entry !== undefined) {
          entry.lastUsedAt = nowMs;
          sticky.expiresAt = nowMs + stickyTtlMs;
          deps.onSelect?.(entry.member.account);
          return entry;
        }
      }
      stickySessions.delete(stickyKey);
    }

    let best: PoolEntry | undefined;
    for (const e of entries) {
      if (!e.member.schedulable) continue; // operator park
      if (usageLimited(e.member, nowMs)) continue; // auto-park cooldown
      if (exclude?.has(e.member.account)) continue; // already tried this request (retry)
      if (
        !best ||
        e.member.priority < best.member.priority ||
        (e.member.priority === best.member.priority && e.lastUsedAt < best.lastUsedAt)
      ) {
        best = e;
      }
    }
    if (!best) throw new Error("oauth pool has no schedulable account");
    best.lastUsedAt = nowMs;
    if (stickyKey) {
      stickySessions.set(stickyKey, {
        account: best.member.account,
        expiresAt: nowMs + stickyTtlMs,
      });
    }
    deps.onSelect?.(best.member.account);
    return best;
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
    call: (client: ProviderClient) => Promise<R>,
  ): Promise<R> {
    const tried = new Set<string>();
    let lastErr: unknown;
    for (;;) {
      let entry: PoolEntry;
      try {
        entry = select(stickyKey, tried);
      } catch (selErr) {
        throw lastErr ?? selErr;
      }
      tried.add(entry.member.account);
      try {
        return await call(entry.member.client);
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
        } else {
          if (!isRetryableTransientError(err)) throw err;
          lastErr = err;
        }
        let next: PoolEntry;
        try {
          next = select(stickyKey, tried);
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
      return completeWithRetry(null, modelFromChat(req), (client) =>
        client.chatCompletion(req, opts),
      );
    },
    chatCompletionStream(
      req: ChatCompletionRequest,
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<string> {
      // Pick SYNCHRONOUSLY (one pick per call) before opening the stream so rotation +
      // onSelect fire on the call turn; streamWithRetry only adds sibling fallbacks.
      const first = select();
      return streamWithRetry(
        first,
        null,
        modelFromChat(req),
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
      return completeWithRetry(stickyKeyFromNative(body), modelFromNative(body), (client) => {
        if (!client.nativePassthrough) {
          throw new Error("oauth pool member does not support native passthrough");
        }
        return client.nativePassthrough(body, opts);
      });
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
      // Pick + fail-closed check SYNCHRONOUSLY on the call turn (rotation + onSelect, and a
      // synchronous throw if the picked member can't passthrough-stream), exactly as before.
      const first = select(stickyKey);
      if (!first.member.client.nativePassthroughStream) {
        throw new Error("oauth pool member does not support native passthrough streaming");
      }
      return streamWithRetry(
        first,
        stickyKey,
        modelFromNative(body),
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
