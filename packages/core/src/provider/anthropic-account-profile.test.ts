import { describe, expect, it } from "vitest";
import type { ConfigStore } from "../store/ports.js";
import { createAnthropicAccountProfileResolver } from "./anthropic-account-profile.js";
import { CLAUDE_CODE_CLIENT_VERSION } from "./oauth/claude-client-version.generated.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function store(): ConfigStore {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async compareAndSet(key, expected, value) {
      if ((values.get(key) ?? null) !== expected) return false;
      values.set(key, value);
      return true;
    },
  };
}

describe("persisted Anthropic account profile", () => {
  it("migrates the existing gateway device once and ignores later seed changes", async () => {
    const config = store();
    const deviceId = "a".repeat(64);
    const first = await createAnthropicAccountProfileResolver(config, deviceId)(A, "2.2.10");
    expect(first.deviceId).toBe(deviceId);
    expect(await createAnthropicAccountProfileResolver(config, "b".repeat(64))(A, null)).toEqual(
      first,
    );
  });

  it("does not reuse a migrated device when an account label is assigned to another UUID", async () => {
    const config = store();
    const resolve = createAnthropicAccountProfileResolver(config, "a".repeat(64));
    const [a, b] = await Promise.all([resolve(A, null), resolve(B, null)]);
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(await resolve(A, null)).toEqual(a);
    expect(await resolve(B, null)).toEqual(b);
  });
  it("retains its logical device through reconstruction and uses distinct devices for distinct accounts", async () => {
    const config = store();
    const resolve = createAnthropicAccountProfileResolver(config);
    const first = await resolve(A, null);
    expect(first.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.clientVersion).toBe(CLAUDE_CODE_CLIENT_VERSION);
    expect(await createAnthropicAccountProfileResolver(config)(A, null)).toEqual(first);
    expect((await resolve(B, null)).deviceId).not.toBe(first.deviceId);
  });

  it("never downgrades the persisted version, including concurrent writers", async () => {
    const config = store();
    const first = createAnthropicAccountProfileResolver(config);
    const second = createAnthropicAccountProfileResolver(config);
    await first(A, "2.1.999");
    await Promise.all([first(A, "2.2.9"), second(A, "2.2.10"), first(A, "2.1.1000")]);
    expect((await second(A, "2.1.1")).clientVersion).toBe("2.2.10");
    expect((await first(A, "2.2.11-preview")).clientVersion).toBe("2.2.10");
  });

  it("fails closed on corrupt persistence or unavailable atomic writes", async () => {
    const config = store();
    const resolve = createAnthropicAccountProfileResolver(config);
    await config.set(`oauth.anthropic_client_profile.v1.${A}`, "corrupt");
    await expect(resolve(A, null)).rejects.toThrow();
    delete config.compareAndSet;
    await expect(resolve(B, null)).rejects.toThrow(/atomic/i);
  });
});
