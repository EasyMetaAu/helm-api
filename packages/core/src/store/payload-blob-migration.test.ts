import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { runPgMigrations } from "./postgres/migrate.js";
import { runMigrations } from "./sqlite/migrate.js";

describe("payload blob provenance migration without request_payloads", () => {
  it("upgrades SQLite v58 without a parent table and remains idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-blob-migration-"));
    const file = join(dir, "db.sqlite");
    let db = new Database(file);
    try {
      db.exec("CREATE TABLE _migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      const seed = db.prepare("INSERT INTO _migrations VALUES(?,0)");
      for (let v = 1; v <= 58; v++) seed.run(v);
      db.close();
      runMigrations(file);
      runMigrations(file);
      db = new Database(file);
      db.pragma("foreign_keys = ON");
      expect(db.pragma("foreign_key_list(request_payload_blob_refs)")).toEqual([]);
      db.prepare("INSERT INTO request_payload_blob_refs VALUES(?,?)").run("request", "sha");
      expect(db.prepare("SELECT * FROM request_payload_blob_refs").all()).toEqual([
        { request_id: "request", sha256: "sha" },
      ]);
      expect(() =>
        db.prepare("INSERT INTO request_payload_blob_refs VALUES(?,?)").run("request", "sha"),
      ).toThrow();
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades Postgres v57 without a parent table and remains idempotent", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(
        "CREATE TABLE _migrations(version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
      );
      for (let v = 1; v <= 57; v++) await client.query("INSERT INTO _migrations VALUES($1,0)", [v]);
      const db = drizzle(client);
      await runPgMigrations(db);
      await runPgMigrations(db);
      expect(
        (
          await client.query(
            "SELECT conname FROM pg_constraint WHERE conrelid = 'request_payload_blob_refs'::regclass AND contype = 'f'",
          )
        ).rows,
      ).toEqual([]);
      await client.query("INSERT INTO request_payload_blob_refs VALUES($1,$2)", ["request", "sha"]);
      expect((await client.query("SELECT * FROM request_payload_blob_refs")).rows).toEqual([
        { request_id: "request", sha256: "sha" },
      ]);
      await expect(
        client.query("INSERT INTO request_payload_blob_refs VALUES($1,$2)", ["request", "sha"]),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
