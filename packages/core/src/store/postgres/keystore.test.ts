import { describe, expect, it } from "vitest";
import { PgKeyStore } from "./keystore.js";
import { createPgliteDb } from "./migrate.js";

describe("PgKeyStore", () => {
  it("getById performs a direct keyed lookup", async () => {
    const store = new PgKeyStore(await createPgliteDb());
    await store.createKey({ keyId: "k1", hash: "h1", prefix: "p1", accountId: "a", role: "user" });
    expect((await store.getById("k1"))?.hash).toBe("h1");
    expect(await store.getById("missing")).toBeNull();
  });
});
