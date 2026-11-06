import { describe, expect, it } from "vitest";
import {
  legacyAnthropicDeviceId,
  stableInstallationId,
  stableSessionId,
} from "./device-identity.js";

const KEY = Buffer.alloc(32, 9);
const KEY2 = Buffer.alloc(32, 11);

describe("legacyAnthropicDeviceId", () => {
  it("preserves the pre-profile derivation for migration", () => {
    expect(legacyAnthropicDeviceId("default", KEY)).toBe(
      "d1b45878e30e672c8f186816300ee1d8da4afa723e7e0ee803a2bd10a0e490f6",
    );
  });
});

describe("stableSessionId", () => {
  it("returns a stable per-account UUID", () => {
    const a = stableSessionId("openai-codex", "default", KEY);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableSessionId("openai-codex", "default", KEY)).toBe(a);
    expect(stableSessionId("openai-codex", "mylukin", KEY)).not.toBe(a);
  });
});

describe("stableInstallationId", () => {
  it("returns a stable per-account UUID that never rotates", () => {
    const a = stableInstallationId("openai-codex", "default", KEY);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableInstallationId("openai-codex", "default", KEY)).toBe(a);
  });

  it("is UNIQUE per account and distinct from that account's session id", () => {
    const a = stableInstallationId("openai-codex", "default", KEY);
    expect(stableInstallationId("openai-codex", "mylukin", KEY)).not.toBe(a);
    expect(stableSessionId("openai-codex", "default", KEY)).not.toBe(a);
    expect(stableInstallationId("openai-codex", "default", KEY2)).not.toBe(a);
  });
});
