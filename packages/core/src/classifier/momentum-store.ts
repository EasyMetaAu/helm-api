import type { MomentumEntry, MomentumStore } from "./momentum.js";

// Default in-memory MomentumStore — session momentum is best-effort SOFT STATE
// (CLAUDE.md principle 3, fail-open): a stateless gateway may lose it, which only
// degrades to "no momentum", never an error. core defines the port and ships a
// process-local Map implementation; a Store adapter can be injected instead so
// core never binds to a concrete DB (CLAUDE.md DB-abstraction). Entries hold only
// complexity/rawScore/at — NEVER plaintext message content (principle 7).
//
// Trimming of expired entries and the history_size cap are applied at READ time
// in applyMomentum (it owns the injected clock and the config); this store just
// keeps insertion-ordered history per session key.
export function createMemoryMomentumStore(): MomentumStore {
  const byKey = new Map<string, MomentumEntry[]>();

  return {
    get(sessionKey: string): MomentumEntry[] {
      return byKey.get(sessionKey) ?? [];
    },
    push(sessionKey: string, entry: MomentumEntry): void {
      const list = byKey.get(sessionKey);
      if (list) {
        list.push(entry);
      } else {
        byKey.set(sessionKey, [entry]);
      }
    },
  };
}
