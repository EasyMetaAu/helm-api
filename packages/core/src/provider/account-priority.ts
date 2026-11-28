import type { InternalRequest } from "@helm/shared";
import { z } from "zod";

// Metadata only. This interface never exposes a credential or a member client.
export const PriorityAccountSchema = z.object({
  account: z.string(),
  priority: z.number().int().nonnegative(),
  eligible: z.boolean(),
});
export type PriorityAccount = z.infer<typeof PriorityAccountSchema>;
export interface AccountPriorityPool {
  kind: "oauth" | "api_key";
  /** False keeps this alias in legacy chain order (API-key round_robin). */
  readonly enabled?: boolean;
  snapshot(model: string, request?: InternalRequest): Promise<PriorityAccount[]>;
  isPinned(request: InternalRequest): boolean;
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
  lastError: unknown;
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
  entries: readonly {
    alias: string;
    candidates: readonly PriorityAccount[];
    snapshot?: () => Promise<readonly PriorityAccount[]>;
  }[],
  run: (alias: string, cursor: AccountPriorityCursor) => Promise<T | undefined>,
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
        const selected = ready[0];
        if (!selected) break;
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
