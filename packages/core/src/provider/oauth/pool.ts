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
}

export interface OAuthPoolDeps {
  members: OAuthPoolMember[];
  // Injected clock (default Date.now) so the LRU cursor is testable.
  now?: () => number;
  // Fires with the selected account on each served call — the seam the gateway
  // uses to record the serving subscription in telemetry / logs (no secrets).
  onSelect?: (account: string) => void;
}

// Internal mutable scheduling record (the member + its rotating cursor).
interface PoolEntry {
  member: OAuthPoolMember;
  lastUsedAt: number;
}

export function createOAuthPoolClient(deps: OAuthPoolDeps): ProviderClient {
  const now = deps.now ?? (() => Date.now());
  const entries: PoolEntry[] = deps.members.map((member) => ({ member, lastUsedAt: 0 }));

  // Pick the next account: lowest priority, then oldest lastUsedAt (LRU round-
  // robin within equal priority). Bumps the winner's cursor and notifies onSelect.
  // Throws when no member is schedulable (fail-closed — the caller treats it as a
  // provider failure and advances the fallback chain).
  function select(): PoolEntry {
    let best: PoolEntry | undefined;
    for (const e of entries) {
      if (!e.member.schedulable) continue;
      if (
        !best ||
        e.member.priority < best.member.priority ||
        (e.member.priority === best.member.priority && e.lastUsedAt < best.lastUsedAt)
      ) {
        best = e;
      }
    }
    if (!best) throw new Error("oauth pool has no schedulable account");
    best.lastUsedAt = now();
    deps.onSelect?.(best.member.account);
    return best;
  }

  return {
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
  };
}
