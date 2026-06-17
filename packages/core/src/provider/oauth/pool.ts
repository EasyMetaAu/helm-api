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
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderClient } from "../openai.js";

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
}

// Internal mutable scheduling record (the member + its rotating cursor).
interface PoolEntry {
  member: OAuthPoolMember;
  lastUsedAt: number;
}

export function createOAuthPoolClient(deps: OAuthPoolDeps): OAuthPoolClient {
  const now = deps.now ?? (() => Date.now());
  const stickyTtlMs = deps.stickyTtlMs ?? 10 * 60 * 1000;
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

  // Pick the next account: lowest priority, then oldest lastUsedAt (LRU round-
  // robin within equal priority). Bumps the winner's cursor and notifies onSelect.
  // Throws when no member is schedulable (fail-closed — the caller treats it as a
  // provider failure and advances the fallback chain).
  function select(stickyKey?: string | null): PoolEntry {
    const nowMs = now();
    if (stickyKey) {
      const sticky = stickySessions.get(stickyKey);
      if (sticky !== undefined && sticky.expiresAt > nowMs) {
        const entry = entries.find(
          (candidate) =>
            candidate.member.account === sticky.account &&
            candidate.member.schedulable &&
            !usageLimited(candidate.member, nowMs),
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

  return {
    // Park / un-park ONE account's auto-park cooldown in place. The next select()
    // observes the new value without a pool rebuild; null clears it (the manual
    // "Reset usage" path). Unknown account = no-op.
    setUsageLimit(account: string, untilMs: number | null): void {
      const entry = entries.find((e) => e.member.account === account);
      if (entry) entry.member.usageLimitedUntilMs = untilMs;
    },
    async chatCompletion(
      req: ChatCompletionRequest,
      opts?: { signal?: AbortSignal },
    ): Promise<ChatCompletionResponse> {
      return select().member.client.chatCompletion(req, opts);
    },
    chatCompletionStream(
      req: ChatCompletionRequest,
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<string> {
      // Select SYNCHRONOUSLY (one pick per call) before opening the stream so the
      // rotation + onSelect fire even though the body is a lazy async iterable.
      return select().member.client.chatCompletionStream(req, opts);
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
      // select() runs SYNCHRONOUSLY at the top of the async body (before any await),
      // so rotation + onSelect fire on the call turn, exactly like the other methods.
      const { client } = select(stickyKeyFromNative(body)).member;
      if (!client.nativePassthrough) {
        throw new Error("oauth pool member does not support native passthrough");
      }
      return client.nativePassthrough(body, opts);
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
      const { client } = select(stickyKeyFromNative(body)).member;
      if (!client.nativePassthroughStream) {
        throw new Error("oauth pool member does not support native passthrough streaming");
      }
      return client.nativePassthroughStream(body, opts);
    },
  };
}
