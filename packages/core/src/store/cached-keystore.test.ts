import { type ApiKeyRecord, ApiKeyRecordSchema } from "@helm/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCachedKeyStore } from "./cached-keystore.js";
import type { CreateKeyInput, KeyPatch, KeyStore } from "./ports.js";

function rec(keyId: string, hash: string): ApiKeyRecord {
  return ApiKeyRecordSchema.parse({
    key_id: keyId,
    hash,
    prefix: "helm_live_xxxx",
    account_id: "acct",
    role: "user",
    allowed_lanes: null,
    allow_custom_model: false,
    blocked_models: null,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
  });
}

// A fake inner KeyStore whose getByHash is a spy over a backing Map, so tests can
// count exactly how many times the wrapper falls through to the "DB".
function makeInner(rows: Map<string, ApiKeyRecord | null> = new Map()): KeyStore {
  return {
    getByHash: vi.fn(async (hash: string) => rows.get(hash) ?? null),
    getById: vi.fn(
      async (keyId: string) => [...rows.values()].find((row) => row?.key_id === keyId) ?? null,
    ),
    createKey: vi.fn(async (input: CreateKeyInput) => rec(input.keyId, input.hash)),
    list: vi.fn(async () => [...rows.values()].filter((r): r is ApiKeyRecord => r !== null)),
    disable: vi.fn(async (_keyId: string) => {}),
    deleteKey: vi.fn(async (_keyId: string) => {}),
    updateKey: vi.fn(async (_keyId: string, _patch: KeyPatch) => {}),
    rotateKey: vi.fn(async (_keyId: string, _input: { hash: string; prefix: string }) => {}),
    getSecretEnc: vi.fn(async (_keyId: string) => "enc:test"),
  };
}

describe("createCachedKeyStore", () => {
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    clock = 1_000;
  });

  it("serves a repeated getByHash from cache without re-hitting the inner store", async () => {
    const rows = new Map<string, ApiKeyRecord | null>([["h1", rec("k1", "h1")]]);
    const inner = makeInner(rows);
    const cached = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 100, now });

    const a = await cached.getByHash("h1");
    const b = await cached.getByHash("h1");

    expect(a?.key_id).toBe("k1");
    expect(b).toEqual(a);
    expect(inner.getByHash).toHaveBeenCalledTimes(1);
  });

  it("delegates getById without scanning list", async () => {
    const rows = new Map<string, ApiKeyRecord | null>([["h1", rec("k1", "h1")]]);
    const inner = makeInner(rows);
    const cached = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 100, now });

    expect((await cached.getById("k1"))?.hash).toBe("h1");
    expect(inner.getById).toHaveBeenCalledWith("k1");
    expect(inner.list).not.toHaveBeenCalled();
  });

  it("caches a negative (null) result so an invalid-key flood does not hammer the DB", async () => {
    const inner = makeInner();
    const cached = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 100, now });

    expect(await cached.getByHash("missing")).toBeNull();
    expect(await cached.getByHash("missing")).toBeNull();
    expect(inner.getByHash).toHaveBeenCalledTimes(1);
  });

  it("re-reads the inner store after the TTL expires", async () => {
    const rows = new Map<string, ApiKeyRecord | null>([["h1", rec("k1", "h1")]]);
    const inner = makeInner(rows);
    const cached = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 100, now });

    await cached.getByHash("h1");
    clock += 29_999; // still inside the window
    await cached.getByHash("h1");
    expect(inner.getByHash).toHaveBeenCalledTimes(1);

    clock += 2; // now past expireAt (1000 + 30000 = 31000; clock = 31001)
    await cached.getByHash("h1");
    expect(inner.getByHash).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used entry past maxEntries", async () => {
    const rows = new Map<string, ApiKeyRecord | null>([
      ["h1", rec("k1", "h1")],
      ["h2", rec("k2", "h2")],
      ["h3", rec("k3", "h3")],
    ]);
    const inner = makeInner(rows);
    const cached = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 2, now });

    await cached.getByHash("h1");
    await cached.getByHash("h2");
    await cached.getByHash("h3"); // evicts h1 (LRU)
    expect(inner.getByHash).toHaveBeenCalledTimes(3);

    await cached.getByHash("h1"); // miss again — was evicted
    expect(inner.getByHash).toHaveBeenCalledTimes(4);
  });

  it("refreshes recency on a cache hit so a hot key survives eviction", async () => {
    const rows = new Map<string, ApiKeyRecord | null>([
      ["h1", rec("k1", "h1")],
      ["h2", rec("k2", "h2")],
      ["h3", rec("k3", "h3")],
    ]);
    const inner = makeInner(rows);
    const cached = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 2, now });

    await cached.getByHash("h1");
    await cached.getByHash("h2");
    await cached.getByHash("h1"); // touch h1 → now h2 is LRU
    await cached.getByHash("h3"); // evicts h2, not h1
    await cached.getByHash("h1"); // still cached
    expect(inner.getByHash).toHaveBeenCalledTimes(3); // h1, h2, h3 — h1 never re-read
  });

  it.each([
    [
      "createKey",
      async (s: KeyStore) =>
        s.createKey({ keyId: "k2", hash: "h2", prefix: "p", accountId: "a", role: "user" }),
    ],
    ["disable", async (s: KeyStore) => s.disable("k1")],
    ["deleteKey", async (s: KeyStore) => s.deleteKey("k1")],
    ["updateKey", async (s: KeyStore) => s.updateKey("k1", { name: "x" })],
    [
      "rotateKey",
      async (s: KeyStore) => s.rotateKey("k1", { hash: "h2", prefix: "helm_live_yyyy" }),
    ],
  ])("busts the whole cache on %s", async (_name, mutate) => {
    const rows = new Map<string, ApiKeyRecord | null>([["h1", rec("k1", "h1")]]);
    const inner = makeInner(rows);
    const cached = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 100, now });

    await cached.getByHash("h1");
    expect(inner.getByHash).toHaveBeenCalledTimes(1);

    await mutate(cached);

    await cached.getByHash("h1");
    expect(inner.getByHash).toHaveBeenCalledTimes(2); // cache was cleared
  });

  it("forwards mutations and reads to the inner store (return values + args)", async () => {
    const inner = makeInner(new Map([["h1", rec("k1", "h1")]]));
    const cached = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 100, now });

    const created = await cached.createKey({
      keyId: "k9",
      hash: "h9",
      prefix: "p",
      accountId: "a",
      role: "user",
    });
    expect(created.key_id).toBe("k9");
    expect(inner.createKey).toHaveBeenCalledWith({
      keyId: "k9",
      hash: "h9",
      prefix: "p",
      accountId: "a",
      role: "user",
    });

    await cached.updateKey("k1", { allowCustomModel: true });
    expect(inner.updateKey).toHaveBeenCalledWith("k1", { allowCustomModel: true });

    await cached.rotateKey("k1", { hash: "h10", prefix: "helm_live_zzzz", secretEnc: "enc:z" });
    expect(inner.rotateKey).toHaveBeenCalledWith("k1", {
      hash: "h10",
      prefix: "helm_live_zzzz",
      secretEnc: "enc:z",
    });

    expect(await cached.getSecretEnc("k1")).toBe("enc:test");
    expect(inner.getSecretEnc).toHaveBeenCalledWith("k1");

    await cached.list();
    expect(inner.list).toHaveBeenCalledTimes(1);
  });
});
