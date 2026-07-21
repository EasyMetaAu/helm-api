import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreConfig } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createStore } from "./factory.js";
import { SqliteKeyStore } from "./sqlite/keystore.js";

// The factory is the single config-driven switch point: core depends only on the
// Store ports, the factory binds the concrete driver ONCE (CLAUDE.md "DB abstraction layer").
// Fail-closed is the contract: an unknown driver, or a supabase driver with no
// resolved connection string, must THROW — never silently fall back to a wrong
// store (principle 2). The Pg* adapters themselves are exercised end-to-end by
// store-contract.test.ts against an in-process PGlite Postgres.
describe("createStore factory", () => {
  it("selects the sqlite adapter set for driver=sqlite (default)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "helm-factory-"));
    const store = await createStore({ store: { driver: "sqlite" }, dataDir });
    expect(store.keys).toBeInstanceOf(SqliteKeyStore);
    // The whole set is present (port-typed) so every caller can be wired from it.
    expect(store.telemetry).toBeDefined();
    expect(store.signals).toBeDefined();
    expect(store.rateLimit).toBeDefined();
    expect(store.memory).toBeDefined();
    expect(store.config).toBeDefined();
    await store.close();
  });

  it("creates a missing sqlite data directory on first run", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "helm-factory-parent-")), "new", "data");
    const store = await createStore({ store: { driver: "sqlite" }, dataDir });
    expect(existsSync(join(dataDir, "helm.db"))).toBe(true);
    await store.close();
  });

  it("fails closed when driver=supabase has no connection string", async () => {
    await expect(createStore({ store: { driver: "supabase" } })).rejects.toThrow(
      /connection string/,
    );
  });

  it("fails closed on an unknown driver (never silently degrades)", async () => {
    await expect(
      // Cast through unknown: the Zod enum rejects this at load time; the factory
      // is the defense-in-depth backstop if a bad value ever reaches it.
      createStore({ store: { driver: "mysql" } as unknown as StoreConfig }),
    ).rejects.toThrow(/unknown store driver/);
  });
});
