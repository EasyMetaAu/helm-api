import { describe, expect, it } from "vitest";
import { codexResetCreditSharedKey } from "./codex-reset-account-key.js";

describe("codexResetCreditSharedKey", () => {
  it("prefers the persisted metadata account id when the access token has no usable claim", () => {
    expect(
      codexResetCreditSharedKey({
        providerId: "openai-codex",
        account: "work-a",
        accessToken: "opaque-token",
        metadata: { accountId: "workspace-42" },
      }),
    ).toBe("codex:workspace-42");
    expect(
      codexResetCreditSharedKey({
        providerId: "openai-codex",
        account: "work-b",
        accessToken: "another-opaque-token",
        metadata: { accountId: "workspace-42" },
      }),
    ).toBe("codex:workspace-42");
  });

  it("uses the access-token claim and otherwise fails closed to the Helm label", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-token",
        },
      }),
    ).toString("base64url");

    expect(
      codexResetCreditSharedKey({
        providerId: "openai-codex",
        account: "work",
        accessToken: `header.${payload}.signature`,
        metadata: {},
      }),
    ).toBe("codex:workspace-token");
    expect(
      codexResetCreditSharedKey({
        providerId: "openai-codex",
        account: "work",
        accessToken: null,
        metadata: {},
      }),
    ).toBe("openai-codex work");
  });

  it("deduplicates labels by the persisted ChatGPT user when account id is unavailable", () => {
    expect(
      codexResetCreditSharedKey({
        providerId: "openai-codex",
        account: "personal-a",
        accessToken: "opaque-token-a",
        metadata: { chatgptUserId: "user-42", email: "USER@example.com" },
      }),
    ).toBe("codex-user:user-42");
    expect(
      codexResetCreditSharedKey({
        providerId: "openai-codex",
        account: "personal-b",
        accessToken: "opaque-token-b",
        metadata: { chatgptUserId: "user-42", email: "user@example.com" },
      }),
    ).toBe("codex-user:user-42");
  });

  it("keeps distinct ChatGPT users on distinct reset-credit guards", () => {
    expect(
      codexResetCreditSharedKey({
        providerId: "openai-codex",
        account: "personal-a",
        accessToken: "opaque-token",
        metadata: { chatgptUserId: "user-a" },
      }),
    ).not.toBe(
      codexResetCreditSharedKey({
        providerId: "openai-codex",
        account: "personal-b",
        accessToken: "opaque-token",
        metadata: { chatgptUserId: "user-b" },
      }),
    );
  });
});
