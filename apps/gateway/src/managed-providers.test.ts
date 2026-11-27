import { ProviderConfigSchema } from "@helm/shared";
import { expect, it } from "vitest";
import { ManagedProviders } from "./managed-providers.js";

it("persists managed endpoints, rejects alias collisions and never revives a removed legacy provider", async () => {
  const data = new Map<string, string>();
  const store = {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => {
      data.set(k, v);
    },
    compareAndSet: async (k: string, old: string | null, v: string) => {
      if ((data.get(k) ?? null) !== old) return false;
      data.set(k, v);
      return true;
    },
  };
  const baseline = [
    ProviderConfigSchema.parse({
      name: "kimi",
      api_key_env: "KIMI_API_KEY",
      models: [{ alias: "kimi/pro", provider_model: "old" }],
    }),
  ];
  const manager = new ManagedProviders(store, Buffer.alloc(32, 2), baseline);
  await manager.load();
  await manager.save({
    id: "kimi",
    label: "Kimi",
    type: "openai",
    base_url: "https://api.kimi.ai/coding/v1",
    models: [{ alias: "kimi/pro", provider_model: "new" }],
  });
  expect(manager.providers()[0]?.api_key_env).toBeUndefined();
  expect(manager.providers()[0]?.api_key_pool?.id).toBe("kimi");
  await expect(
    manager.save({
      id: "other",
      label: "Other",
      type: "openai",
      base_url: "https://example.com",
      models: [{ alias: "kimi/pro", provider_model: "x" }],
    }),
  ).rejects.toThrow(/alias/i);
  await manager.remove("kimi");
  const restarted = new ManagedProviders(store, Buffer.alloc(32, 2), baseline);
  await restarted.load();
  expect(restarted.providers()).toEqual([]);
  expect(JSON.stringify([...data.values()])).not.toContain("api.kimi.ai");
});

it("refreshes another instance after edits and account changes, retaining provider order and removed aliases", async () => {
  const data = new Map<string, string>();
  const store = {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => {
      data.set(k, v);
    },
    compareAndSet: async (k: string, old: string | null, v: string) => {
      if ((data.get(k) ?? null) !== old) return false;
      data.set(k, v);
      return true;
    },
  };
  const baseline = [
    ProviderConfigSchema.parse({ name: "first", api_key_env: "FIRST_KEY", models: [] }),
    ProviderConfigSchema.parse({ name: "last", api_key_env: "LAST_KEY", models: [] }),
  ];
  const first = new ManagedProviders(store, Buffer.alloc(32, 2), baseline);
  const replica = new ManagedProviders(store, Buffer.alloc(32, 2), baseline);
  await first.load();
  await replica.load();
  const profile = {
    id: "first",
    label: "First",
    type: "openai",
    base_url: "https://example.com",
    models: [{ alias: "plain-alias", provider_model: "wire" }],
  };
  await first.save(profile);
  expect(await replica.loadIfChanged()).toBe(true);
  expect(replica.providers().map((p) => p.name)).toEqual(["first", "last"]);
  expect(await replica.loadIfChanged()).toBe(false);
  await first.bindLegacy("first", {
    accountId: "account",
    generation: "generation",
    endpoint: "openai:https://example.com",
    owner: null,
  });
  await first.touch();
  expect(await replica.loadIfChanged()).toBe(true);
  await first.save({ ...profile, models: [{ alias: "new-alias", provider_model: "wire" }] });
  await replica.loadIfChanged();
  expect(replica.ownsAlias("plain-alias")).toBe(true);
  expect(replica.legacyBinding("first")?.accountId).toBe("account");
  await first.remove("first");
  await replica.loadIfChanged();
  expect(replica.providers().map((p) => p.name)).toEqual(["last"]);
  expect(replica.ownsAlias("new-alias")).toBe(true);
});
