import { afterEach, describe, expect, it } from "vitest";
import type { OAuthTokenRecord, OAuthTokenStore } from "./ports.js";
import { createPgliteDb } from "./postgres/migrate.js";
import { PgOAuthTokenStore } from "./postgres/oauth-tokens.js";
import { createSqliteDb } from "./sqlite/migrate.js";
import { SqliteOAuthTokenStore } from "./sqlite/oauth-tokens.js";

// ONE contract, BOTH real drivers (mirrors store-contract.test.ts): the SAME
// assertions run against the sqlite adapter AND the Postgres adapter on in-process
// PGlite. The store treats `accessEnc`/`refreshEnc` as opaque blobs — it stores
// and returns them verbatim and never decrypts (encryption lives in the caller).

interface Driver {
  name: string;
  make: () => Promise<{ store: OAuthTokenStore; close: () => Promise<void> }>;
}

const drivers: Driver[] = [
  {
    name: "sqlite",
    make: async () => {
      const db = createSqliteDb(":memory:");
      return {
        store: new SqliteOAuthTokenStore(db),
        close: async () => {
          db.$sqlite.close();
        },
      };
    },
  },
  {
    name: "postgres",
    make: async () => {
      const db = await createPgliteDb();
      return { store: new PgOAuthTokenStore(db), close: () => db.$close() };
    },
  },
];

const rec = (over: Partial<OAuthTokenRecord> = {}): OAuthTokenRecord => ({
  providerId: "anthropic",
  account: "default",
  accessEnc: "v1:access-blob",
  refreshEnc: "v1:refresh-blob",
  expiresAt: 1_000,
  meta: null,
  updatedAt: 500,
  ...over,
});

for (const driver of drivers) {
  describe(`OAuthTokenStore contract — ${driver.name}`, () => {
    let close: () => Promise<void>;
    afterEach(async () => {
      await close?.();
    });

    it("returns null for an unknown provider/account", async () => {
      const { store, close: c } = await driver.make();
      close = c;
      expect(await store.get("anthropic", "default")).toBeNull();
    });

    it("upsert -> get round-trips the ciphertext blobs verbatim", async () => {
      const { store, close: c } = await driver.make();
      close = c;
      const r = rec();
      await store.upsert(r);
      expect(await store.get("anthropic", "default")).toEqual(r);
    });

    it("upsert overwrites the same (provider, account) row (rotation write-back)", async () => {
      const { store, close: c } = await driver.make();
      close = c;
      await store.upsert(rec({ refreshEnc: "v1:old", updatedAt: 1 }));
      await store.upsert(rec({ refreshEnc: "v1:rotated", expiresAt: 9_999, updatedAt: 2 }));
      const got = await store.get("anthropic", "default");
      expect(got?.refreshEnc).toBe("v1:rotated");
      expect(got?.expiresAt).toBe(9_999);
      // Still exactly one row for the pair.
      expect((await store.list()).filter((x) => x.providerId === "anthropic")).toHaveLength(1);
    });

    it("isolates rows by account and by provider", async () => {
      const { store, close: c } = await driver.make();
      close = c;
      await store.upsert(rec({ account: "work", refreshEnc: "v1:work" }));
      await store.upsert(rec({ account: "personal", refreshEnc: "v1:personal" }));
      await store.upsert(rec({ providerId: "github-copilot", refreshEnc: "v1:copilot" }));
      expect((await store.get("anthropic", "work"))?.refreshEnc).toBe("v1:work");
      expect((await store.get("anthropic", "personal"))?.refreshEnc).toBe("v1:personal");
      expect((await store.get("github-copilot", "default"))?.refreshEnc).toBe("v1:copilot");
    });

    it("delete removes only the targeted row", async () => {
      const { store, close: c } = await driver.make();
      close = c;
      await store.upsert(rec({ account: "a" }));
      await store.upsert(rec({ account: "b" }));
      await store.delete("anthropic", "a");
      expect(await store.get("anthropic", "a")).toBeNull();
      expect(await store.get("anthropic", "b")).not.toBeNull();
    });

    it("list returns inventory WITHOUT secret columns", async () => {
      const { store, close: c } = await driver.make();
      close = c;
      await store.upsert(rec());
      const list = await store.list();
      expect(list).toHaveLength(1);
      const entry = list[0] as Record<string, unknown>;
      expect(entry).toMatchObject({ providerId: "anthropic", account: "default" });
      expect(entry.accessEnc).toBeUndefined();
      expect(entry.refreshEnc).toBeUndefined();
    });

    it("persists null access + meta JSON (copilot-style lazy access)", async () => {
      const { store, close: c } = await driver.make();
      close = c;
      const r = rec({
        providerId: "github-copilot",
        accessEnc: null,
        expiresAt: null,
        meta: JSON.stringify({ proxyBase: "https://api.example.copilot" }),
      });
      await store.upsert(r);
      expect(await store.get("github-copilot", "default")).toEqual(r);
    });
  });
}
