import { describe, expect, it } from "vitest";
import { ApiKeyAccounts } from "../provider/api-key-pool.js";
import { UpstreamError } from "../provider/openai.js";
import { PgConfigStore } from "./postgres/config-store.js";
import { createPgliteDb } from "./postgres/migrate.js";
import { SqliteConfigStore } from "./sqlite/config-store.js";
import { createSqliteDb } from "./sqlite/migrate.js";

for (const driver of ["sqlite", "postgres"] as const) {
  describe(`API key pool persistence (${driver})`, () => {
    it("atomically replaces one config row, encrypts keys and admits only one recovery probe", async () => {
      const sqlite = driver === "sqlite" ? createSqliteDb(":memory:") : null;
      const pg = driver === "postgres" ? await createPgliteDb() : null;
      const store = sqlite ? new SqliteConfigStore(sqlite) : new PgConfigStore(pg!);
      try {
        expect(await store.compareAndSet("cas", null, "first")).toBe(true);
        expect(await store.compareAndSet("cas", null, "lost")).toBe(false);
        expect(await store.compareAndSet("cas", "wrong", "lost")).toBe(false);
        expect(await store.compareAndSet("cas", "first", "next")).toBe(true);
        expect(await store.get("cas")).toBe("next");
        let time = Date.parse("2026-10-29T00:00:00Z");
        const options = {
          store,
          encKey: Buffer.alloc(32, 4),
          poolId: "test",
          timezone: "Asia/Shanghai",
          now: () => time,
        };
        const a = new ApiKeyAccounts(options);
        const b = new ApiKeyAccounts(options);
        await a.add([{ name: "first", key: "sk-proj-db-contract" }]);
        expect(await store.get("provider.api_keys.test")).not.toContain("sk-proj-db-contract");
        const id = (await b.list())[0]!.id;
        await a.settle(
          (await a.acquire(id))!,
          new UpstreamError(
            "upstream_error",
            "quota",
            { error: { code: "insufficient_quota" } },
            429,
          ),
        );
        expect((await b.list())[0]?.state).toBe("quota_exhausted");
        time = Date.parse("2026-10-31T16:00:00Z");
        const attempts = await Promise.all([a.acquire(id), b.acquire(id)]);
        expect(attempts.filter(Boolean)).toHaveLength(1);
        await a.settle(attempts.find(Boolean)!, null);
        expect((await b.list())[0]?.state).toBe("ready");
      } finally {
        sqlite?.$sqlite.close();
        await pg?.$close();
      }
    });
  });
}
