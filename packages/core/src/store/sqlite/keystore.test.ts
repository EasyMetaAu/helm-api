import { describe, expect, it } from "vitest";
import { SqliteKeyStore } from "./keystore.js";
import { createSqliteDb } from "./migrate.js";

function freshStore() {
  const db = createSqliteDb(":memory:");
  return new SqliteKeyStore(db);
}

describe("SqliteKeyStore", () => {
  it("round-trips create -> getByHash with all fields", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "sha256_h1",
      prefix: "helm_live_ab12",
      accountId: "acct",
      role: "user",
      maxLane: "balanced",
      allowedLanes: ["economy", "balanced"],
      allowCustomModel: true,
    });
    const got = await store.getByHash("sha256_h1");
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      key_id: "k1",
      hash: "sha256_h1",
      prefix: "helm_live_ab12",
      account_id: "acct",
      role: "user",
      max_lane: "balanced",
      allowed_lanes: ["economy", "balanced"],
      allow_custom_model: true,
      disabled: false,
    });
  });

  it("never persists a plaintext key (only hash + prefix)", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "sha256_of_plaintext",
      prefix: "helm_live_ab12",
      accountId: "acct",
      role: "root",
    });
    const got = await store.getByHash("sha256_of_plaintext");
    // record exposes hash + prefix, no plaintext-bearing field
    expect(got && "plaintext" in got).toBe(false);
    expect(got?.hash).toBe("sha256_of_plaintext");
    expect(got?.prefix).toBe("helm_live_ab12");
  });

  it("disable is a soft flag: key still retrievable, only disabled changes", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "helm_live_a",
      accountId: "acct",
      role: "user",
      maxLane: "balanced",
    });
    await store.disable("k1");
    const got = await store.getByHash("h1");
    expect(got).not.toBeNull();
    expect(got?.disabled).toBe(true);
    // other fields untouched (no in-place rewrite)
    expect(got?.max_lane).toBe("balanced");
    expect(got?.prefix).toBe("helm_live_a");
  });

  it("disable on a missing key rejects (not silently)", async () => {
    const store = freshStore();
    await expect(store.disable("nope")).rejects.toThrow();
  });

  it("list returns [] when empty and all records when populated", async () => {
    const store = freshStore();
    expect(await store.list()).toEqual([]);
    await store.createKey({ keyId: "k1", hash: "h1", prefix: "p1", accountId: "a", role: "root" });
    await store.createKey({ keyId: "k2", hash: "h2", prefix: "p2", accountId: "a", role: "user" });
    const all = await store.list();
    expect(all).toHaveLength(2);
    for (const r of all) {
      expect("plaintext" in r).toBe(false);
    }
  });

  it("getByHash returns null on a miss (no throw)", async () => {
    const store = freshStore();
    expect(await store.getByHash("unknown")).toBeNull();
  });

  it("restores boolean/array dialect on read", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "p1",
      accountId: "a",
      role: "user",
      allowedLanes: ["balanced", "premium"],
      allowCustomModel: false,
    });
    const got = await store.getByHash("h1");
    expect(got?.allowed_lanes).toEqual(["balanced", "premium"]);
    expect(got?.allow_custom_model).toBe(false);
  });

  it("rejects a duplicate hash (unique constraint)", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "same",
      prefix: "p1",
      accountId: "a",
      role: "root",
    });
    await expect(
      store.createKey({ keyId: "k2", hash: "same", prefix: "p2", accountId: "a", role: "user" }),
    ).rejects.toThrow();
  });

  it("defaults per-key rate limits to null (inherit system default) when omitted", async () => {
    const store = freshStore();
    await store.createKey({ keyId: "k1", hash: "h1", prefix: "p1", accountId: "a", role: "user" });
    const got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBeNull();
    expect(got?.rate_limit_tpm).toBeNull();
  });

  it("round-trips per-key rate limits set at creation (0 = explicit unlimited)", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "p1",
      accountId: "a",
      role: "user",
      rateLimitRpm: 60,
      rateLimitTpm: 0,
    });
    const got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBe(60);
    expect(got?.rate_limit_tpm).toBe(0);
  });

  it("updateRateLimit sets, clears (null), and leaves other fields untouched", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "helm_live_a",
      accountId: "a",
      role: "user",
      maxLane: "balanced",
    });
    await store.updateRateLimit("k1", { rpm: 100, tpm: 5000 });
    let got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBe(100);
    expect(got?.rate_limit_tpm).toBe(5000);
    // other fields untouched (no in-place rewrite of unrelated columns)
    expect(got?.max_lane).toBe("balanced");
    expect(got?.disabled).toBe(false);
    // null clears the override back to inheriting the system default
    await store.updateRateLimit("k1", { rpm: null, tpm: null });
    got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBeNull();
    expect(got?.rate_limit_tpm).toBeNull();
  });

  it("updateRateLimit is PARTIAL: an omitted dimension is left untouched", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "p1",
      accountId: "a",
      role: "user",
      rateLimitRpm: 10,
      rateLimitTpm: 20,
    });
    // Patch only rpm; tpm must survive unchanged (no read-modify-write clobber).
    await store.updateRateLimit("k1", { rpm: 99 });
    let got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBe(99);
    expect(got?.rate_limit_tpm).toBe(20);
    // Patch only tpm to null (clear); rpm must survive.
    await store.updateRateLimit("k1", { tpm: null });
    got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBe(99);
    expect(got?.rate_limit_tpm).toBeNull();
  });

  it("updateRateLimit on a missing key rejects — both with a patch and an empty patch", async () => {
    const store = freshStore();
    await expect(store.updateRateLimit("nope", { rpm: 1, tpm: 1 })).rejects.toThrow();
    await expect(store.updateRateLimit("nope", {})).rejects.toThrow();
  });
});
