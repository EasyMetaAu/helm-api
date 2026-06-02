import type { ProviderConfig as ProviderConfigShared } from "@helm/shared";
import { ProviderConfigSchema } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCredential, buildProviderClients } from "./server.js";

// Compose a validated shared ProviderConfig (so tests exercise the real schema
// shape, not a hand-rolled object). Parse never fails for these fixtures.
function provider(raw: Record<string, unknown>): ProviderConfigShared {
  return ProviderConfigSchema.parse(raw);
}

const OAUTH_PROVIDER = provider({
  name: "claude-sub",
  type: "openai",
  base_url: "https://oauth.example.com/v1",
  oauth: {
    grant: "refresh_token",
    token_url: "https://oauth.example.com/token",
    client_id_env: "OA_CLIENT_ID",
    client_secret_env: "OA_CLIENT_SECRET",
    refresh_token_env: "OA_REFRESH_TOKEN",
  },
  models: [{ alias: "claude-sub/opus", provider_model: "claude-opus" }],
});

const KEY_PROVIDER = provider({
  name: "openai",
  type: "openai",
  base_url: "https://api.openai.com/v1",
  api_key_env: "OPENAI_API_KEY",
  models: [{ alias: "openai/gpt", provider_model: "gpt-4o" }],
});

const OAUTH_ENV = {
  OA_CLIENT_ID: "cid",
  OA_CLIENT_SECRET: "csecret",
  OA_REFRESH_TOKEN: "rtok",
};

function setEnv(env: Record<string, string>): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
    keys.push(k);
  }
  return keys;
}

const ADDED_KEYS: string[] = [];
afterEach(() => {
  for (const k of ADDED_KEYS.splice(0)) delete process.env[k];
  vi.restoreAllMocks();
});

describe("buildCredential (issue #38 OAuth wiring)", () => {
  it("returns a static apiKey credential when api_key_env is set", () => {
    ADDED_KEYS.push(...setEnv({ OPENAI_API_KEY: "sk-static" }));
    const cred = buildCredential(KEY_PROVIDER);
    expect(cred).toEqual({ apiKey: "sk-static" });
  });

  it("returns null when a key provider's env is unset (fail-open at caller)", () => {
    const cred = buildCredential(KEY_PROVIDER);
    expect(cred).toBeNull();
  });

  it("builds a dynamic OAuth credential when all secrets are present", () => {
    ADDED_KEYS.push(...setEnv(OAUTH_ENV));
    const cred = buildCredential(OAUTH_PROVIDER);
    expect(cred).not.toBeNull();
    if (cred && "getAuthHeader" in cred) {
      expect(typeof cred.getAuthHeader).toBe("function");
      expect(typeof cred.onUnauthorized).toBe("function");
      expect(typeof cred.currentSecrets).toBe("function");
    } else {
      throw new Error("expected a dynamic OAuth credential");
    }
  });

  it("returns null when a required OAuth secret env is unset (fail-open)", () => {
    ADDED_KEYS.push(...setEnv({ OA_CLIENT_ID: "cid", OA_CLIENT_SECRET: "csecret" }));
    // refresh_token_env missing for a refresh_token grant → cannot build.
    const cred = buildCredential(OAUTH_PROVIDER);
    expect(cred).toBeNull();
  });
});

describe("buildProviderClients (issue #38 OAuth wiring)", () => {
  it("builds an OAuth client that requests with a fetched Bearer", async () => {
    ADDED_KEYS.push(...setEnv(OAUTH_ENV));
    // Intercept BOTH the token endpoint and the chat endpoint.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/token")) {
          return new Response(JSON.stringify({ access_token: "fetched-at", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    const clients = buildProviderClients([OAUTH_PROVIDER], "https://fallback/v1", 60_000);
    const client = clients.get("claude-sub");
    expect(client).toBeDefined();
    await client?.chatCompletion({ model: "m" });
    // Find the chat call and assert it carried the fetched Bearer.
    const chatCall = fetchSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/chat/completions"),
    );
    expect(chatCall).toBeDefined();
    const init = chatCall?.[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer fetched-at");
  });

  it("skips an OAuth provider whose secret is unset but keeps the others (fail-open)", () => {
    ADDED_KEYS.push(...setEnv({ OPENAI_API_KEY: "sk-static" }));
    // OAUTH_ENV intentionally NOT set → the OAuth provider is skipped.
    const clients = buildProviderClients(
      [KEY_PROVIDER, OAUTH_PROVIDER],
      "https://fallback/v1",
      60_000,
    );
    expect(clients.has("openai")).toBe(true);
    expect(clients.has("claude-sub")).toBe(false);
  });
});
