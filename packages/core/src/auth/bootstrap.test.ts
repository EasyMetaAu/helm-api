import { describe, expect, it, vi } from "vitest";
import { SqliteKeyStore } from "../store/sqlite/keystore.js";
import { createSqliteDb } from "../store/sqlite/migrate.js";
import { bootstrapRootKey } from "./bootstrap.js";
import { generateKey, hashKey } from "./keygen.js";

function freshKeyStore() {
  return new SqliteKeyStore(createSqliteDb(":memory:"));
}

describe("bootstrapRootKey", () => {
  it("creates exactly one root key on an empty store", async () => {
    const keyStore = freshKeyStore();
    const res = await bootstrapRootKey({
      keyStore,
      generateKey,
      now: () => new Date(),
      log: () => {},
    });
    expect(res.created).toBe(true);
    const all = await keyStore.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.role).toBe("root");
  });

  it("root key opts OUT of memory (management plane: no inject/auto-thread)", async () => {
    const keyStore = freshKeyStore();
    await bootstrapRootKey({ keyStore, generateKey, now: () => new Date(), log: () => {} });
    const stored = (await keyStore.list())[0];
    // Despite the keystore minting inject/auto for normal new keys, the bootstrap
    // root key is explicitly management-plane and must stay memory-inert.
    expect(stored?.memory_mode).toBe("off");
    expect(stored?.memory_thread_source).toBe("header");
  });

  it("prints the plaintext exactly once and never persists it", async () => {
    const keyStore = freshKeyStore();
    const fixed = generateKey();
    const logs: string[] = [];
    await bootstrapRootKey({
      keyStore,
      generateKey: () => fixed,
      now: () => new Date(),
      log: (l) => logs.push(l),
    });
    const printedOnce = logs.filter((l) => l.includes(fixed.plaintext));
    expect(printedOnce).toHaveLength(1);
    // persisted record holds hash + prefix, not plaintext
    const stored = (await keyStore.list())[0];
    expect(stored?.hash).toBe(fixed.hash);
    expect(JSON.stringify(stored)).not.toContain(fixed.plaintext);
  });

  it("is idempotent across restarts: existing key -> no-op", async () => {
    const keyStore = freshKeyStore();
    const log = vi.fn();
    await bootstrapRootKey({ keyStore, generateKey, now: () => new Date(), log });
    log.mockClear();
    const res = await bootstrapRootKey({ keyStore, generateKey, now: () => new Date(), log });
    expect(res).toEqual({ created: false, keyId: null });
    expect(await keyStore.list()).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("persists sha256(plaintext), not the plaintext itself", async () => {
    const keyStore = freshKeyStore();
    const fixed = generateKey();
    await bootstrapRootKey({
      keyStore,
      generateKey: () => fixed,
      now: () => new Date(),
      log: () => {},
    });
    const stored = (await keyStore.list())[0];
    expect(stored?.hash).toBe(hashKey(fixed.plaintext));
  });

  it("propagates store read failures (fail-closed, no silent anonymous access)", async () => {
    const failing = {
      list: vi.fn().mockRejectedValue(new Error("db down")),
      createKey: vi.fn(),
      getByHash: vi.fn(),
      disable: vi.fn(),
      deleteKey: vi.fn(),
      updateKey: vi.fn(),
    };
    await expect(
      bootstrapRootKey({ keyStore: failing, generateKey, now: () => new Date(), log: () => {} }),
    ).rejects.toThrow("db down");
    expect(failing.createKey).not.toHaveBeenCalled();
  });
});
