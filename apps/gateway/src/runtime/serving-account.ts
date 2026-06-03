import { AsyncLocalStorage } from "node:async_hooks";

// Per-request "which OAuth subscription served this call" holder (providers page
// Tier 2 usage attribution). The pool's `onSelect(account)` fires DEEP inside
// routeRequest → execute (it has no request id, no Hono context), while the served
// tokens/cost are only known later in the route's settle path. AsyncLocalStorage
// bridges the two WITHOUT widening the framework-free ProviderClient contract
// (Principle 1) and WITHOUT perturbing the streaming body (Principle 8).
//
// SCOPING (the only sharp edge): the store is entered around the synchronous
// routeRequest() call ONLY — `onSelect` fires there (the pool selects, and execute
// peeks the first chunk, before the stream is handed back), so it writes into THIS
// request's holder. The gateway then reads the holder OUT of the result and threads
// the plain `{ providerId, account }` value forward to the settle path — so token
// recording never depends on ALS surviving into Hono's deferred stream callback.

export interface ServingAccount {
  providerId: string;
  account: string;
}

// Mutable holder the pool's onSelect writes into; read synchronously after route().
export interface ServingAccountHolder {
  selected: ServingAccount | null;
}

export const servingAccountStore = new AsyncLocalStorage<ServingAccountHolder>();

// Record the selected subscription for the current request (called by onSelect).
// No-op when not inside a `run` scope (e.g. a non-OAuth request, or a unit test
// that never enters one) — fail-open, never throws.
export function markServingAccount(providerId: string, account: string): void {
  const holder = servingAccountStore.getStore();
  if (holder) holder.selected = { providerId, account };
}

// Run `fn` inside a fresh holder and return BOTH its result and whichever account
// onSelect marked (null when none — a configured/non-OAuth provider served).
export async function withServingAccountCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; servingAccount: ServingAccount | null }> {
  const holder: ServingAccountHolder = { selected: null };
  const result = await servingAccountStore.run(holder, fn);
  return { result, servingAccount: holder.selected };
}

// Did the marked subscription ACTUALLY serve the request? `onSelect` marks the
// account at SELECTION time — before the upstream call succeeds — so on a fallback
// (the marked OAuth attempt fails, a LATER candidate serves) the holder is stale.
// Attribute usage only when the final SERVED alias belongs to the marked account's
// provider: a synthesized OAuth pool serves `<providerId>/<model>` aliases, so the
// served alias must be prefixed with `<providerId>/`. A null/errored alias, or one
// from a different provider (e.g. a configured non-OAuth fallback), is NOT a match
// → no (mis)attribution. Pure + side-effect-free for unit testing.
export function servedByAccount(
  servingAccount: ServingAccount | null,
  servedAlias: string | null,
): boolean {
  if (!servingAccount || !servedAlias) return false;
  return servedAlias.startsWith(`${servingAccount.providerId}/`);
}
