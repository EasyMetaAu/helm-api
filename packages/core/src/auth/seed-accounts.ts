import type { CreditStore } from "../store/ports.js";

// The two account-id literals that already exist in the wild (Issue #37 现状第 6
// 条): the bootstrap root key is minted under "acct_default" (bootstrap.ts), while
// admin-minted keys default to "default" (server.ts). Both MUST have an account
// row or the credit gate would read a null balance for one of them. Rather than a
// risky data migration that rewrites existing key.account_id values, we seed BOTH
// literals so every existing key resolves to a real account row. New deployments
// can standardize on "acct_default"; "default" stays for backward compatibility.
export const BOOTSTRAP_ACCOUNT_IDS = ["acct_default", "default"] as const;

// Idempotently provision the bootstrap account rows. ensureAccount inserts-if-
// absent and never clobbers an existing balance, so this is safe to call on every
// startup (mirrors bootstrapRootKey's idempotence). Read/write failures propagate
// (fail-closed at startup, principle 2) — a half-provisioned credit subsystem must
// stop the boot, not run blind.
export async function ensureSeedAccounts(
  store: Pick<CreditStore, "ensureAccount">,
  now: () => number = () => Date.now(),
): Promise<void> {
  for (const accountId of BOOTSTRAP_ACCOUNT_IDS) {
    await store.ensureAccount({ accountId, name: null, nowMs: now() });
  }
}
