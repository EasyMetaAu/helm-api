import { createHash } from "node:crypto";
import type { InternalRequest } from "@helm/shared";
import { z } from "zod";

// Metadata only. This interface never exposes a credential or a member client.
export const PriorityAccountSchema = z.object({
  account: z.string(),
  priority: z.number().int().nonnegative(),
  eligible: z.boolean(),
  /** Sharing weight ignores transient capacity; dispatch eligibility still includes it. */
  sharingEligible: z.boolean().optional(),
});
export type PriorityAccount = z.infer<typeof PriorityAccountSchema>;
export interface AccountPriorityPool {
  kind: "oauth" | "api_key";
  /** False keeps legacy same-model routing in chain order; an explicit lane opt-in overrides it. */
  readonly enabled?: boolean;
  snapshot(
    model: string,
    request?: InternalRequest,
    lanePriority?: boolean,
  ): Promise<PriorityAccount[]>;
  isPinned(request: InternalRequest): boolean;
  /** Digest of the existing pool soft-affinity key; never returns raw session data. */
  affinityHash?(request: InternalRequest): string | null;
}
export function nextPriority(accounts: readonly PriorityAccount[]): number | null {
  const eligible = accounts.filter((account) => account.eligible);
  return eligible.length ? Math.min(...eligible.map((account) => account.priority)) : null;
}
export function priorityGroups(
  candidates: readonly {
    alias: string;
    model: string;
    kind: AccountPriorityPool["kind"];
    candidates: readonly PriorityAccount[];
  }[],
): string[][] {
  const groups = new Map<string, (typeof candidates)[number][]>();
  for (const candidate of candidates) {
    if (candidate.model === "auto" || candidate.model.endsWith("/auto")) continue;
    const group = groups.get(candidate.model) ?? [];
    group.push(candidate);
    groups.set(candidate.model, group);
  }
  return [...groups.values()]
    .filter((group) => {
      const available = group.filter((entry) => nextPriority(entry.candidates) !== null);
      return (
        new Set(available.map((entry) => entry.kind)).size === 2 &&
        available.some((entry) =>
          entry.candidates.some((account) => account.eligible && account.priority !== 50),
        )
      );
    })
    .map((group) =>
      group.filter((entry) => nextPriority(entry.candidates) !== null).map((entry) => entry.alias),
    );
}

export interface PriorityPoolEntry {
  alias: string;
  /** Stable provider/pool identity; aliases of one pool must not multiply its weight. */
  pool?: string;
  candidates: readonly PriorityAccount[];
}
export interface PrioritySharingOptions {
  affinityHash?: string | null;
  random?: () => number;
}
export const PriorityPoolSelectionSchema = z.object({
  pool: z.string(),
  pool_selection_reason: z.enum(["weighted_random", "sticky", "single_pool"]),
  pool_weight: z.number().int().positive(),
  tier_pool_count: z.number().int().positive(),
  affinity_hash: z.string().nullable(),
});
export type PriorityPoolSelection = z.infer<typeof PriorityPoolSelectionSchema>;

/** Weighted rendezvous: exponential races give each pool weight / total probability.
 * Sorted identities make seeded random draws and sticky ranking independent of chain order.
 * A removed peer does not disturb a surviving sticky winner (with unchanged weights).
 */
export function rankPriorityPools(
  entries: readonly PriorityPoolEntry[],
  priority: number,
  options: PrioritySharingOptions = {},
): { pool: string; weight: number }[] {
  const accounts = new Map<string, Set<string>>();
  for (const entry of entries) {
    const pool = entry.pool ?? entry.alias;
    for (const account of entry.candidates) {
      if (!(account.sharingEligible ?? account.eligible) || account.priority !== priority) continue;
      const set = accounts.get(pool) ?? new Set<string>();
      set.add(account.account);
      accounts.set(pool, set);
    }
  }
  const weights = [...accounts]
    .map(([pool, set]) => ({ pool, weight: set.size }))
    .sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
  if (weights.length < 2) return weights;
  return weights
    .map((entry) => {
      const draw = options.affinityHash
        ? (createHash("sha256")
            .update(JSON.stringify([options.affinityHash, entry.pool]))
            .digest()
            .readUIntBE(0, 6) +
            0.5) /
          2 ** 48
        : (options.random ?? Math.random)();
      const unit = Number.isFinite(draw)
        ? Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, draw))
        : 0.5;
      return { ...entry, score: -Math.log(unit) / entry.weight };
    })
    .sort((a, b) => a.score - b.score || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0))
    .map(({ pool, weight }) => ({ pool, weight }));
}

/** Internal control flow, never a provider fault or a client-facing error. */
export class PriorityCursorCancelled extends Error {
  constructor() {
    super("account priority cursor superseded");
  }
}

/** A suspended pool call retains its own tried set, error and retry budget on its stack. */
export class AccountPriorityCursor {
  state: "new" | "running" | "waiting" | "done" = "new";
  candidates: readonly PriorityAccount[];
  priority: number | null = null;
  private error: unknown;
  failureRevision = 0;
  get lastError(): unknown {
    return this.error;
  }
  set lastError(error: unknown) {
    this.error = error;
    this.failureRevision++;
  }
  poolSelection?: PriorityPoolSelection;
  onSelect?: (account: string, priority: number) => void;
  private permit: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  private localSnapshot?: () => readonly PriorityAccount[];
  private pauseStarted: number | null = null;
  private completedPauseMs = 0;
  get pausedMs(): number {
    return (
      this.completedPauseMs +
      (this.pauseStarted === null ? 0 : performance.now() - this.pauseStarted)
    );
  }
  private timers = new Set<(active: boolean) => void>();
  constructor(
    accounts: readonly PriorityAccount[],
    private readonly changed: () => void,
    private readonly snapshot: () => Promise<readonly PriorityAccount[]> = async () => accounts,
  ) {
    this.candidates = accounts;
  }
  async refresh(): Promise<void> {
    const accounts = await this.snapshot();
    this.candidates = this.localSnapshot ? this.localSnapshot() : accounts;
  }
  async wait(snapshot: () => readonly PriorityAccount[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.localSnapshot = snapshot;
    this.candidates = snapshot();
    this.state = "waiting";
    this.pauseStarted = performance.now();
    for (const timer of this.timers) timer(false);
    const promise = new Promise<void>((resolve, reject) => {
      this.permit = { resolve, reject };
    });
    const abort = () =>
      this.permit?.reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    this.changed();
    try {
      await promise;
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", abort);
      this.permit = null;
    }
  }
  resume(): void {
    this.completedPauseMs = this.pausedMs;
    this.pauseStarted = null;
    this.priority = nextPriority(this.candidates);
    this.state = "running";
    for (const timer of this.timers) timer(true);
    this.permit?.resolve();
  }
  cancel(): void {
    this.permit?.reject(new PriorityCursorCancelled());
  }
  /** Preserve the remaining active budget across pauses; request abort stays live. */
  scheduleTimeout(ms: number, fire: () => void): () => void {
    let remaining = ms;
    let started = 0;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const change = (active: boolean) => {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
        remaining = Math.max(0, remaining - (performance.now() - started));
      }
      if (active) {
        started = performance.now();
        handle = setTimeout(fire, remaining);
      }
    };
    this.timers.add(change);
    change(this.state !== "waiting");
    return () => {
      if (handle !== undefined) clearTimeout(handle);
      this.timers.delete(change);
    };
  }
}

/** Only one alias runs at a time. Others are suspended before selecting/sending. */
export async function coordinateAccountPriority<T>(
  entries: readonly (PriorityPoolEntry & {
    snapshot?: () => Promise<readonly PriorityAccount[]>;
  })[],
  run: (alias: string, cursor: AccountPriorityCursor) => Promise<T | undefined>,
  options: PrioritySharingOptions = {},
): Promise<T | undefined> {
  let revision = 0;
  let wake: (() => void) | undefined;
  const changed = () => {
    revision++;
    wake?.();
    wake = undefined;
  };
  const states = entries.map((entry) => ({
    ...entry,
    cursor: new AccountPriorityCursor(entry.candidates, changed, entry.snapshot),
    task: undefined as Promise<void> | undefined,
  }));
  const visited = new Map<number, Set<string>>();
  // Starting a pool and its first wait are one choice. A second preflight/send wait
  // without a pool fault also retains that choice; only a fault rotates peers.
  let continuing: { alias: string; priority: number; failureRevision: number } | undefined;
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    while (states.some((state) => state.cursor.state !== "done")) {
      const seen = revision;
      if (failed) throw failure;
      if (result !== undefined) return result;
      if (!states.some((state) => state.cursor.state === "running")) {
        const pending = states.filter((state) => state.cursor.state !== "done");
        for (const state of pending) await state.cursor.refresh();
        // A request abort can finish a paused call during an asynchronous store read.
        // Never grant a new send after that terminal result, or resurrect a done cursor.
        if (failed || result !== undefined) continue;
        const ready = states.filter((state) => state.cursor.state !== "done");
        // Empty cursors finish their existing failure path before another send.
        ready.sort(
          (a, b) =>
            (nextPriority(a.cursor.candidates) ?? -Infinity) -
            (nextPriority(b.cursor.candidates) ?? -Infinity),
        );
        let selected = ready[0];
        if (!selected) break;
        const priority = nextPriority(selected.cursor.candidates);
        if (priority !== null) {
          const tier = ready.filter((state) => nextPriority(state.cursor.candidates) === priority);
          const same =
            continuing?.priority === priority
              ? tier.find(
                  (state) =>
                    state.alias === continuing?.alias &&
                    state.cursor.failureRevision === continuing.failureRevision,
                )
              : undefined;
          if (same) selected = same;
          else {
            const seenPools = visited.get(priority) ?? new Set<string>();
            let available = tier.filter((state) => !seenPools.has(state.pool ?? state.alias));
            if (!available.length) {
              seenPools.clear();
              available = tier;
            }
            const ranked = rankPriorityPools(
              available.map((state) => ({ ...state, candidates: state.cursor.candidates })),
              priority,
              options,
            );
            const chosen = ranked[0];
            if (!chosen) break;
            selected =
              available.find((state) => (state.pool ?? state.alias) === chosen.pool) ?? selected;
            const tierPoolCount = new Set(tier.map((state) => state.pool ?? state.alias)).size;
            selected.cursor.poolSelection = {
              pool: chosen.pool,
              pool_selection_reason:
                tierPoolCount === 1
                  ? "single_pool"
                  : options.affinityHash
                    ? "sticky"
                    : "weighted_random",
              pool_weight: chosen.weight,
              tier_pool_count: tierPoolCount,
              affinity_hash: options.affinityHash?.slice(0, 16) ?? null,
            };
            seenPools.add(chosen.pool);
            visited.set(priority, seenPools);
            continuing = {
              alias: selected.alias,
              priority,
              failureRevision: selected.cursor.failureRevision,
            };
          }
        }
        if (selected.cursor.state === "new") {
          selected.cursor.state = "running";
          selected.task = run(selected.alias, selected.cursor)
            .then(
              (value) => {
                if (value !== undefined) result = value;
              },
              (error) => {
                failed = true;
                failure = error;
              },
            )
            .finally(() => {
              selected.cursor.state = "done";
              changed();
            });
        } else selected.cursor.resume();
      }
      if (seen === revision)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    if (failed) throw failure;
    return result;
  } finally {
    for (const state of states) if (state.cursor.state === "waiting") state.cursor.cancel();
    await Promise.all(states.map((state) => state.task));
  }
}
