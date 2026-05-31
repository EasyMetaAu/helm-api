import type { MomentumEntry, MomentumStore } from "./momentum.js";

// Default in-memory MomentumStore — session momentum is best-effort SOFT STATE
// (CLAUDE.md principle 3, fail-open): a stateless gateway may lose it, which only
// degrades to "no momentum", never an error. core defines the port and ships a
// process-local Map implementation; a Store adapter can be injected instead so
// core never binds to a concrete DB (CLAUDE.md DB-abstraction). Entries hold only
// complexity/rawScore/at — NEVER plaintext message content (principle 7).
//
// The singleton lives for the whole process lifetime (server.ts), so growth must
// be bounded at WRITE time — read-time trimming (applyMomentum) does not stop the
// stored arrays or the key set from leaking. We mirror the eval cache's TTL+LRU
// container with two hard caps:
//   1. maxEntriesPerKey — each key's array is trimmed to its newest N on push;
//   2. maxKeys          — the number of session keys is LRU-bounded (Map insertion
//      order ⇒ first key is least-recently-used; touched keys move to the back).
// The MomentumStore port (get/push) is unchanged; caps arrive via optional ctor
// options so createMemoryMomentumStore() with no args still works.

export interface MemoryMomentumStoreOptions {
  /** Hard cap on history entries kept per session key (newest survive). */
  maxEntriesPerKey?: number;
  /** Hard cap on distinct session keys (LRU eviction of the oldest). */
  maxKeys?: number;
}

// Safe defaults: small per-key history (read-time history_size is typically ≤ 5,
// so 16 leaves headroom without unbounded growth) and a generous key ceiling that
// still caps total memory at a few thousand short arrays.
const DEFAULT_MAX_ENTRIES_PER_KEY = 16;
const DEFAULT_MAX_KEYS = 10_000;

export function createMemoryMomentumStore(options: MemoryMomentumStoreOptions = {}): MomentumStore {
  const maxEntriesPerKey = options.maxEntriesPerKey ?? DEFAULT_MAX_ENTRIES_PER_KEY;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const byKey = new Map<string, MomentumEntry[]>();

  return {
    get(sessionKey: string): MomentumEntry[] {
      return byKey.get(sessionKey) ?? [];
    },
    push(sessionKey: string, entry: MomentumEntry): void {
      let list = byKey.get(sessionKey);
      if (list) {
        // Touch recency: delete + re-insert moves the key to the most-recent
        // position so the LRU victim is always the front of the Map.
        byKey.delete(sessionKey);
      } else {
        list = [];
      }
      list.push(entry);
      // Trim each key's array to its newest entries (drop oldest from the front).
      if (list.length > maxEntriesPerKey) {
        list = list.slice(-maxEntriesPerKey);
      }
      byKey.set(sessionKey, list);
      // Evict least-recently-used keys until within the key-count cap.
      while (byKey.size > maxKeys) {
        const oldest = byKey.keys().next().value;
        if (oldest === undefined) break;
        byKey.delete(oldest);
      }
    },
  };
}
