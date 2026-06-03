import { describe, expect, it } from "vitest";
import { anthropicMetadataUserId, stableSessionId } from "./device-identity.js";

const KEY = Buffer.alloc(32, 9);
const KEY2 = Buffer.alloc(32, 11);

describe("anthropicMetadataUserId", () => {
  it("is STABLE for the same (provider, account, key) — never rotates", () => {
    const a = anthropicMetadataUserId("anthropic", "default", KEY);
    const b = anthropicMetadataUserId("anthropic", "default", KEY);
    expect(a).toBe(b);
  });

  it("is a JSON {device_id (64-hex), account_uuid:'', session_id (uuid)} envelope", () => {
    const parsed = JSON.parse(anthropicMetadataUserId("anthropic", "default", KEY)) as {
      device_id: string;
      account_uuid: string;
      session_id: string;
    };
    expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.account_uuid).toBe("");
    expect(parsed.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // device_id and session_id are derived from DIFFERENT labels → not equal.
    expect(parsed.device_id).not.toContain(parsed.session_id.replace(/-/g, ""));
  });

  it("is UNIQUE per account and per provider (no cross-account collision)", () => {
    const d1 = anthropicMetadataUserId("anthropic", "default", KEY);
    const d2 = anthropicMetadataUserId("anthropic", "mylukin", KEY);
    const d3 = anthropicMetadataUserId("github-copilot", "default", KEY);
    expect(new Set([d1, d2, d3]).size).toBe(3);
  });

  it("is salted by the encryption key (not guessable from account alone)", () => {
    expect(anthropicMetadataUserId("anthropic", "default", KEY)).not.toBe(
      anthropicMetadataUserId("anthropic", "default", KEY2),
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
