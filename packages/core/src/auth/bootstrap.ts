import type { KeyStore } from "../store/ports.js";
import type { GeneratedKey } from "./keygen.js";

// Bootstrap a root key on first start. If the store has NO keys, generate one
// role=root key, print the plaintext ONCE for the operator, and persist it
// (hash + prefix only). If any key already exists, do nothing (idempotent across
// restarts). Store read failures propagate (fail-closed) — we never degrade to
// anonymous access. See docs/06, docs/10, CLAUDE.md principle 7.

export interface BootstrapDeps {
  keyStore: KeyStore;
  generateKey: () => GeneratedKey;
  now: () => Date;
  log: (line: string) => void;
}

export interface BootstrapResult {
  created: boolean;
  keyId: string | null;
}

const ROOT_KEY_ID = "k_root" as const;

export async function bootstrapRootKey(deps: BootstrapDeps): Promise<BootstrapResult> {
  // Read failures throw and abort startup (fail-closed) — do not catch here.
  const existing = await deps.keyStore.list();
  if (existing.length > 0) {
    return { created: false, keyId: null };
  }

  const key = deps.generateKey();
  await deps.keyStore.createKey({
    keyId: ROOT_KEY_ID,
    hash: key.hash, // only hash + prefix persisted; plaintext never stored
    prefix: key.prefix,
    accountId: "acct_default",
    role: "root",
    allowCustomModel: true,
  });

  // Print the plaintext exactly once for the operator to capture.
  deps.log(
    `Helm root API key generated (store it now; shown once, keep it safe, do not use it directly for production traffic):\n  ${key.plaintext}`,
  );

  return { created: true, keyId: ROOT_KEY_ID };
}
