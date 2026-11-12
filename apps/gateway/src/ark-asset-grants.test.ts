import type { ConfigStore, KeyStore } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { ArkAssetGrants } from "./ark-asset-grants.js";

function setup() {
  const rows = new Map<string, string>();
  const config: ConfigStore = {
    get: vi.fn(async (k) => rows.get(k) ?? null),
    set: async (k, v) => {
      rows.set(k, v);
    },
    compareAndSet: vi.fn(async (k, old, v) => {
      if ((rows.get(k) ?? null) !== old) return false;
      rows.set(k, v);
      return true;
    }),
  };
  const keys = {
    getById: async (id: string) => ({ key_id: id, account_id: "tenant", disabled: false }),
  } as KeyStore;
  let scope = "scope-a";
  const service = new ArkAssetGrants(config, keys, () => scope);
  return {
    rows,
    config,
    service,
    rotate: () => {
      scope = "scope-b";
    },
  };
}
const input = {
  revision: null,
  providerName: "ark",
  attestation: "same-account-project-enrolled" as const,
  assets: [{ assetId: "asset-synthetic-001", mediaType: "image" as const }],
};
const refs = [{ assetId: "asset-synthetic-001", mediaType: "image" as const }];
const identity = { accountId: "tenant", keyId: "key-a" };
describe("Ark asset grants", () => {
  it("binds tenant, key, provider credential and modality; revokes without caching", async () => {
    const s = setup();
    await expect(s.service.authorize(identity, "ark", "scope-a", refs)).rejects.toMatchObject({
      status: 403,
    });
    const saved = await s.service.replace("key-a", input);
    expect(saved).not.toHaveProperty("providerScope");
    await s.service.authorize(identity, "ark", "scope-a", refs);
    for (const who of [
      { ...identity, keyId: "key-b" },
      { ...identity, accountId: "other" },
    ] as const)
      await expect(s.service.authorize(who, "ark", "scope-a", refs)).rejects.toMatchObject({
        status: 403,
      });
    for (const [provider, scope] of [
      ["other", "scope-a"],
      ["ark", "scope-b"],
    ] as const)
      await expect(s.service.authorize(identity, provider, scope, refs)).rejects.toMatchObject({
        status: 403,
      });
    await expect(
      s.service.authorize(identity, "ark", "scope-a", [
        ...refs,
        { assetId: "asset-other", mediaType: "image" },
      ]),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      s.service.authorize(identity, "ark", "scope-a", [
        { assetId: "asset-synthetic-001", mediaType: "audio" },
      ]),
    ).rejects.toMatchObject({ status: 403 });
    await expect(s.service.replace("key-a", input)).rejects.toMatchObject({ status: 409 });
    await s.service.replace("key-a", { ...input, revision: saved.revision, assets: [] });
    await expect(s.service.authorize(identity, "ark", "scope-a", refs)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("fails closed on corrupt storage and reports replacement credentials as inactive", async () => {
    const s = setup();
    await s.service.replace("key-a", input);
    s.rotate();
    expect((await s.service.read("key-a")).active).toBe(false);
    s.rows.set("ark-asset-grants:key-a", "{}");
    await expect(s.service.authorize(identity, "ark", "scope-a", refs)).rejects.toMatchObject({
      status: 503,
    });
    vi.mocked(s.config.get).mockRejectedValue(new Error("private database message"));
    await expect(s.service.authorize(identity, "ark", "scope-a", refs)).rejects.toMatchObject({
      status: 503,
      message: "Asset authorization unavailable",
    });
  });
});
