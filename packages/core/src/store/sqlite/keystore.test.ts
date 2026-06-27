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
      allowedLanes: ["economy", "balanced"],
    });
    await store.disable("k1");
    const got = await store.getByHash("h1");
    expect(got).not.toBeNull();
    expect(got?.disabled).toBe(true);
    // other fields untouched (no in-place rewrite)
    expect(got?.allowed_lanes).toEqual(["economy", "balanced"]);
    expect(got?.prefix).toBe("helm_live_a");
  });

  it("disable on a missing key rejects (not silently)", async () => {
    const store = freshStore();
    await expect(store.disable("nope")).rejects.toThrow();
  });

  it("deleteKey physically removes the row (gone from getByHash and list)", async () => {
    const store = freshStore();
    await store.createKey({ keyId: "k1", hash: "h1", prefix: "p1", accountId: "a", role: "user" });
    await store.createKey({ keyId: "k2", hash: "h2", prefix: "p2", accountId: "a", role: "user" });
    await store.deleteKey("k1");
    expect(await store.getByHash("h1")).toBeNull();
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.key_id).toBe("k2");
  });

  it("deleteKey on a missing key rejects (not silently)", async () => {
    const store = freshStore();
    await expect(store.deleteKey("nope")).rejects.toThrow();
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

  it("list() orders by createdAt then key_id, regardless of insertion order or updates", async () => {
    const db = createSqliteDb(":memory:");
    let t = 0;
    const store = new SqliteKeyStore(db, () => new Date(t));
    // Insert OUT of order; two share a createdAt to exercise the key_id tiebreaker.
    t = 300;
    await store.createKey({
      keyId: "zeta",
      hash: "h0",
      prefix: "p0",
      accountId: "a",
      role: "user",
    });
    t = 100;
    await store.createKey({ keyId: "kb", hash: "h1", prefix: "p1", accountId: "a", role: "user" });
    t = 100;
    await store.createKey({ keyId: "ka", hash: "h2", prefix: "p2", accountId: "a", role: "user" });
    // createdAt asc (ka/kb=100 before zeta=300); key_id asc within the tie (ka before kb).
    expect((await store.list()).map((k) => k.key_id)).toEqual(["ka", "kb", "zeta"]);
    // Stable after an unrelated mutation — disabling a row must not reshuffle the list.
    await store.disable("ka");
    expect((await store.list()).map((k) => k.key_id)).toEqual(["ka", "kb", "zeta"]);
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

  it("updateKey sets rate limits, clears (null), and leaves other fields untouched", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "helm_live_a",
      accountId: "a",
      role: "user",
      allowedLanes: ["balanced"],
    });
    await store.updateKey("k1", { rateLimitRpm: 100, rateLimitTpm: 5000 });
    let got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBe(100);
    expect(got?.rate_limit_tpm).toBe(5000);
    // other fields untouched (no in-place rewrite of unrelated columns)
    expect(got?.allowed_lanes).toEqual(["balanced"]);
    expect(got?.disabled).toBe(false);
    // null clears the override back to inheriting the system default
    await store.updateKey("k1", { rateLimitRpm: null, rateLimitTpm: null });
    got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBeNull();
    expect(got?.rate_limit_tpm).toBeNull();
  });

  it("updateKey edits caps: allowed_lanes, allow_custom_model (set + clear)", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "p1",
      accountId: "a",
      role: "user",
      rateLimitRpm: 7,
    });
    await store.updateKey("k1", {
      allowedLanes: ["economy", "balanced"],
      allowCustomModel: true,
    });
    let got = await store.getByHash("h1");
    expect(got?.allowed_lanes).toEqual(["economy", "balanced"]);
    expect(got?.allow_custom_model).toBe(true);
    // an unrelated column (rate limit) is left untouched
    expect(got?.rate_limit_rpm).toBe(7);
    // role is never written by updateKey
    expect(got?.role).toBe("user");
    // null clears the whitelist back to "no cap"
    await store.updateKey("k1", { allowedLanes: null });
    got = await store.getByHash("h1");
    expect(got?.allowed_lanes).toBeNull();
    expect(got?.allow_custom_model).toBe(true);
  });

  it("updateKey is PARTIAL: an omitted field is left untouched", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "p1",
      accountId: "a",
      role: "user",
      allowedLanes: ["balanced"],
      rateLimitRpm: 10,
      rateLimitTpm: 20,
    });
    // Patch only rpm; tpm and allowed_lanes must survive (no read-modify-write clobber).
    await store.updateKey("k1", { rateLimitRpm: 99 });
    let got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBe(99);
    expect(got?.rate_limit_tpm).toBe(20);
    expect(got?.allowed_lanes).toEqual(["balanced"]);
    // Patch only tpm to null (clear); rpm and allowed_lanes must survive.
    await store.updateKey("k1", { rateLimitTpm: null });
    got = await store.getByHash("h1");
    expect(got?.rate_limit_rpm).toBe(99);
    expect(got?.rate_limit_tpm).toBeNull();
    expect(got?.allowed_lanes).toEqual(["balanced"]);
  });

  it("updateKey on a missing key rejects — both with a patch and an empty patch", async () => {
    const store = freshStore();
    await expect(store.updateKey("nope", { rateLimitRpm: 1, rateLimitTpm: 1 })).rejects.toThrow();
    await expect(store.updateKey("nope", {})).rejects.toThrow();
  });

  it("defaults name to null when omitted; round-trips a name set at creation", async () => {
    const store = freshStore();
    await store.createKey({ keyId: "k1", hash: "h1", prefix: "p1", accountId: "a", role: "user" });
    expect((await store.getByHash("h1"))?.name).toBeNull();
    await store.createKey({
      keyId: "k2",
      hash: "h2",
      prefix: "p2",
      accountId: "a",
      role: "user",
      name: "Production backend",
    });
    expect((await store.getByHash("h2"))?.name).toBe("Production backend");
  });

  it("updateKey renames a key (set + clear) and leaves other fields untouched", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "p1",
      accountId: "a",
      role: "user",
      name: "Initial",
      allowedLanes: ["balanced"],
      rateLimitRpm: 7,
    });
    await store.updateKey("k1", { name: "Renamed" });
    let got = await store.getByHash("h1");
    expect(got?.name).toBe("Renamed");
    // unrelated columns survive (no read-modify-write clobber); role never written
    expect(got?.allowed_lanes).toEqual(["balanced"]);
    expect(got?.rate_limit_rpm).toBe(7);
    expect(got?.role).toBe("user");
    // null clears the name back to unnamed
    await store.updateKey("k1", { name: null });
    got = await store.getByHash("h1");
    expect(got?.name).toBeNull();
    expect(got?.allowed_lanes).toEqual(["balanced"]);
  });

  it("updateKey leaves name untouched when the patch omits it", async () => {
    const store = freshStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "p1",
      accountId: "a",
      role: "user",
      name: "Keep me",
    });
    await store.updateKey("k1", { rateLimitRpm: 99 });
    expect((await store.getByHash("h1"))?.name).toBe("Keep me");
  });
});
