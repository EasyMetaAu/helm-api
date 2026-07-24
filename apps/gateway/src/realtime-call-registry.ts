import type { RealtimeSidebandTarget } from "@helm/core";

export interface RealtimeCallRegistry {
  put(callId: string, keyId: string, target: RealtimeSidebandTarget): void;
  take(
    callId: string,
    keyId: string,
  ): { ok: true; target: RealtimeSidebandTarget } | { ok: false; reason: "not_found" };
  readonly size: number;
}

export function createRealtimeCallRegistry(
  options: { ttlMs?: number; now?: () => number } = {},
): RealtimeCallRegistry {
  // ponytail: process-local registry matches today's single gateway replica; use a
  // shared atomic claim store before horizontally scaling Realtime ingress.
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const calls = new Map<
    string,
    { keyId: string; target: RealtimeSidebandTarget; expiresAt: number }
  >();
  const prune = (nowMs: number) => {
    for (const [callId, call] of calls) if (call.expiresAt <= nowMs) calls.delete(callId);
  };

  return {
    put(callId, keyId, target) {
      const nowMs = now();
      prune(nowMs);
      calls.set(callId, { keyId, target, expiresAt: nowMs + ttlMs });
    },
    take(callId, keyId) {
      prune(now());
      const call = calls.get(callId);
      if (!call || call.keyId !== keyId) return { ok: false, reason: "not_found" };
      calls.delete(callId);
      return { ok: true, target: call.target };
    },
    get size() {
      prune(now());
      return calls.size;
    },
  };
}
