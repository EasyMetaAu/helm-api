import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createCachedKeyStore } from "./cached-keystore.js";
import { PgKeyStore } from "./postgres/keystore.js";
import { createPgliteDb } from "./postgres/migrate.js";
import { SqliteKeyStore } from "./sqlite/keystore.js";
import { createSqliteDb } from "./sqlite/migrate.js";

describe.each(["sqlite", "postgres"])("%s client policy persistence", (dialect) => {
  it("round trips policy, preserves it on rotation/partial edit, clears it explicitly and invalidates auth cache", async () => {
    const db = dialect === "sqlite" ? createSqliteDb(":memory:") : await createPgliteDb();
    const inner = "$sqlite" in db ? new SqliteKeyStore(db) : new PgKeyStore(db);
    const store = createCachedKeyStore(inner, { ttlMs: 30_000, maxEntries: 10, now: () => 1 });
    try {
      const policy = { allowed_clients: ["codex_app" as const] };
      const rec = await store.createKey({
        keyId: "k",
        hash: "h",
        prefix: "p",
        accountId: "a",
        role: "user",
      });
      expect(rec.client_policy).toBeNull();
      await store.getByHash("h");
      await store.updateKey("k", { clientPolicy: policy });
      expect((await store.getByHash("h"))?.client_policy).toEqual(policy);
      await store.updateKey("k", { name: "renamed" });
      expect((await store.getById("k"))?.client_policy).toEqual(policy);
      await store.rotateKey("k", { hash: "new-h", prefix: "new-p", secretEnc: null });
      expect((await store.getByHash("new-h"))?.client_policy).toEqual(policy);
      await store.updateKey("k", { clientPolicy: null });
      expect((await store.getByHash("new-h"))?.client_policy).toBeNull();
      const created = await store.createKey({
        keyId: "k2",
        hash: "h2",
        prefix: "p",
        accountId: "a",
        role: "user",
        clientPolicy: policy,
      });
      expect(created.client_policy).toEqual(policy);
      // Corrupt persisted policy must never normalize into unrestricted access.
      if ("$sqlite" in db)
        db.$sqlite
          .prepare("UPDATE api_keys SET client_policy = ? WHERE key_id = ?")
          .run('{"allowed_clients":[]}', "k2");
      else
        await db.execute(
          sql`UPDATE api_keys SET client_policy = '{"allowed_clients":[]}'::jsonb WHERE key_id = 'k2'`,
        );
      await expect(inner.getById("k2")).rejects.toThrow();
    } finally {
      if ("$sqlite" in db) db.$sqlite.close();
      else await db.$close();
    }
  });
});

it("upgrades an existing SQLite key without enabling a client restriction", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "helm-policy-migration-"));
  const path = join(dir, "db.sqlite");
  let db = createSqliteDb(path);
  try {
    await new SqliteKeyStore(db).createKey({
      keyId: "legacy",
      hash: "legacy-hash",
      prefix: "test",
      accountId: "a",
      role: "user",
    });
    db.$sqlite.exec(
      "ALTER TABLE api_keys DROP COLUMN client_policy; DELETE FROM _migrations WHERE version = 54;",
    );
    db.$sqlite.close();
    db = createSqliteDb(path);
    expect((await new SqliteKeyStore(db).getByHash("legacy-hash"))?.client_policy).toBeNull();
  } finally {
    db.$sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("upgrades an existing Postgres key without enabling a client restriction", async () => {
  const { runPgMigrations } = await import("./postgres/migrate.js");
  const db = await createPgliteDb();
  try {
    await new PgKeyStore(db).createKey({
      keyId: "legacy",
      hash: "legacy-hash",
      prefix: "test",
      accountId: "a",
      role: "user",
    });
    await db.execute(sql.raw("ALTER TABLE api_keys DROP COLUMN client_policy"));
    await db.execute(sql.raw("DELETE FROM _migrations WHERE version = 53"));
    await runPgMigrations(db);
    expect((await new PgKeyStore(db).getByHash("legacy-hash"))?.client_policy).toBeNull();
  } finally {
    await db.$close();
  }
});
