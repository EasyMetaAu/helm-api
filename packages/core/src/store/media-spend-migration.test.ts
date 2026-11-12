import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { runPgMigrations } from "./postgres/migrate.js";
import { runMigrations } from "./sqlite/migrate.js";

// Seed the previous migration versions so only this change's DDL is executed.
describe("media spend schema upgrade", () => {
  it("upgrades SQLite v57 and remains idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-media-migration-")),
      file = join(dir, "db.sqlite");
    let db = new Database(file);
    try {
      db.exec("CREATE TABLE _migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)");
      const seed = db.prepare("INSERT INTO _migrations VALUES(?,0)");
      for (let v = 1; v <= 57; v++) seed.run(v);
      db.close();
      runMigrations(file);
      runMigrations(file);
      db = new Database(file);
      expect(db.prepare("SELECT version FROM _migrations WHERE version=58").get()).toEqual({
        version: 58,
      });
      db.prepare("INSERT INTO media_spend_records VALUES(?,?,?)").run("id", "owner", "{}");
      expect(db.prepare("SELECT key_id FROM media_spend_records WHERE id=?").get("id")).toEqual({
        key_id: "owner",
      });
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("upgrades Postgres v56 and remains idempotent", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(
        "CREATE TABLE _migrations(version INTEGER PRIMARY KEY,applied_at BIGINT NOT NULL)",
      );
      for (let v = 1; v <= 56; v++) await client.query("INSERT INTO _migrations VALUES($1,0)", [v]);
      const db = drizzle(client);
      await runPgMigrations(db);
      await runPgMigrations(db);
      const rows = await client.query<{ version: number }>(
        "SELECT version FROM _migrations WHERE version=57",
      );
      expect(rows.rows).toEqual([{ version: 57 }]);
      await client.query("INSERT INTO media_spend_records VALUES($1,$2,$3)", ["id", "owner", "{}"]);
      expect(
        (await client.query("SELECT key_id FROM media_spend_records WHERE id=$1", ["id"])).rows,
      ).toEqual([{ key_id: "owner" }]);
    } finally {
      await client.close();
    }
  });
});
