import type { KeyStore } from "../store/ports.js";
import type { GeneratedKey } from "./keygen.js";

// Bootstrap a root key on first start. If the store has NO keys AND
// generate_if_missing is on, generate one role=root key, persist it (hash + prefix
// only), optionally write the plaintext to the operator's persist_to file, and print
// it ONCE. If any key already exists, do nothing (idempotent across restarts). Store
// read failures propagate (fail-closed) — we never degrade to anonymous access.
// See docs/06, docs/10, CLAUDE.md principle 7.

export interface BootstrapDeps {
  keyStore: KeyStore;
  generateKey: () => GeneratedKey;
  now: () => Date;
  log: (line: string) => void;
  // From config.auth.bootstrap (review H1 — these were previously IGNORED). Optional
  // so unit tests and headless callers keep the historical defaults (auto-mint + print).
  generateIfMissing?: boolean; // default true; false ⇒ never auto-mint (keys managed out-of-band)
  printOnce?: boolean; // default true; false ⇒ do not log the plaintext (rely on persist)
  // Invoked once with the freshly-minted plaintext when bootstrap.persist_to is wired;
  // the gateway writes it to the operator's file (0600). Best-effort — a failure is
  // logged, never fatal (the key is already in the store).
  persist?: (plaintext: string) => Promise<void>;
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

  // generate_if_missing:false — the operator manages keys out-of-band (hardened or
  // replicated deploy) and explicitly opted OUT of auto-minting (review H1: this was
  // previously ignored, so the control gave false assurance). Honor it: do NOT mint.
  // The gateway still requires a key, so requests fail closed until one is provisioned
  // — the operator's deliberate choice, surfaced as a warning rather than a silent mint.
  if (deps.generateIfMissing === false) {
    deps.log(
      "no API keys exist and bootstrap.generate_if_missing is false — not minting a root key; requests will be rejected until a key is provisioned",
    );
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
    // The root key is the management/bootstrap plane ("do not use for production
    // traffic", logged below) — opt it OUT of the new-key memory mint defaults
    // (mode "inject" / thread_source "auto"). A management key must never
    // observe/inject memory or derive conversation threads from request signals.
    memoryMode: "off",
    memoryThreadSource: "header",
  });

  // persist_to: write the plaintext to the operator's configured file (review H1 —
  // previously a mandatory-but-ignored field). If printing is still enabled, a write
  // failure is non-fatal because the log remains a recovery channel. If printing is
  // disabled, a write failure would make the root key unrecoverable; roll the row back
  // and fail closed so the next boot can mint again after the path is fixed.
  if (deps.persist) {
    try {
      await deps.persist(key.plaintext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`failed to persist root key to bootstrap.persist_to: ${message}`);
      if (deps.printOnce === false) {
        try {
          await deps.keyStore.deleteKey(ROOT_KEY_ID);
          deps.log("rolled back generated root key after bootstrap.persist_to failure");
        } catch (rollbackErr) {
          deps.log(
            `failed to roll back generated root key after bootstrap.persist_to failure: ${
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
            }`,
          );
        }
        throw new Error(
          `failed to persist root key to bootstrap.persist_to and print_once is false: ${message}`,
        );
      }
    }
  }

  // print_once (default true): log the plaintext exactly once for the operator. false
  // suppresses it — only safe when persist_to captured the key (review H1).
  if (deps.printOnce !== false) {
    deps.log(
      `Helm root API key generated (store it now; shown once, keep it safe, do not use it directly for production traffic):\n  ${key.plaintext}`,
    );
  }

  return { created: true, keyId: ROOT_KEY_ID };
}
