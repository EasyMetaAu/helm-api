import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PgKeyStore } from "./keystore.js";
import { createPgliteDb, runPgMigrations } from "./migrate.js";

describe("PgKeyStore", () => {
  it("upgrades existing keys without restoring revoked keys and can rerun migrations", async () => {
    const db = await createPgliteDb();
    try {
      const store = new PgKeyStore(db);
      await store.createKey({
        keyId: "active",
        hash: "active",
        prefix: "a",
        accountId: "a",
        role: "user",
      });
      await store.createKey({
        keyId: "revoked",
        hash: "revoked",
        prefix: "r",
        accountId: "a",
        role: "user",
      });
      await store.disable("revoked");
      await db.execute(sql.raw("ALTER TABLE api_keys DROP COLUMN suspended"));
      await db.execute(sql.raw("DELETE FROM _migrations WHERE version = 55"));
      await runPgMigrations(db);
      await runPgMigrations(db);
      expect(await store.getById("active")).toMatchObject({ disabled: false, suspended: false });
      expect(await store.getById("revoked")).toMatchObject({ disabled: true, suspended: false });
    } finally {
      await db.$close();
    }
  });

  it("persists reversible suspension without changing the secret or revocation", async () => {
    const db = await createPgliteDb();
    const store = new PgKeyStore(db);
    try {
      const original = await store.createKey({
        keyId: "pause",
        hash: "same-hash",
        prefix: "same-prefix",
        accountId: "a",
        role: "user",
      });
      await store.updateKey("pause", { suspended: true });
      expect(await store.getByHash("same-hash")).toMatchObject({
        ...original,
        suspended: true,
        disabled: false,
      });
      expect((await store.list())[0]?.suspended).toBe(true);
      await store.updateKey("pause", { suspended: false });
      expect(await store.getById("pause")).toMatchObject({ ...original, suspended: false });
      await store.disable("pause");
      await store.updateKey("pause", { suspended: false });
      expect((await store.getById("pause"))?.disabled).toBe(true);
    } finally {
      await db.$close();
    }
  });

  it("getById performs a direct keyed lookup", async () => {
    const store = new PgKeyStore(await createPgliteDb());
    await store.createKey({ keyId: "k1", hash: "h1", prefix: "p1", accountId: "a", role: "user" });
    expect((await store.getById("k1"))?.hash).toBe("h1");
    expect(await store.getById("missing")).toBeNull();
  });
});
