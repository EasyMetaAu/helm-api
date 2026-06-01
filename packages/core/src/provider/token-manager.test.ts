import { describe, expect, it, vi } from "vitest";
import { createTokenManager, type ResolvedOAuth, TokenRefreshError } from "./token-manager.js";

const REFRESH_OAUTH: ResolvedOAuth = {
  grant: "refresh_token",
  tokenUrl: "https://oauth.test/token",
  clientId: "cid-123",
  clientSecret: "csecret-456",
  refreshToken: "rtok-initial",
  scopes: [],
};

const CC_OAUTH: ResolvedOAuth = {
  grant: "client_credentials",
  tokenUrl: "https://oauth.test/token",
  clientId: "cid-123",
  clientSecret: "csecret-456",
  scopes: ["models.read"],
  audience: "https://api.test",
};

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createTokenManager", () => {
  it("refreshes on first call and returns a Bearer header", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "at-1", expires_in: 3600 }));
    const tm = createTokenManager({ oauth: REFRESH_OAUTH, fetch, now: () => 0 });
    const header = await tm.getAuthHeader();
    expect(header).toBe("Bearer at-1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serves the cached token within its TTL (no second refresh)", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "at-1", expires_in: 3600 }));
    let clock = 0;
    const tm = createTokenManager({ oauth: REFRESH_OAUTH, fetch, now: () => clock });
    await tm.getAuthHeader();
    clock = 1000 * 1000; // +1000s, still inside 3600s - 60s skew
    await tm.getAuthHeader();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes again once the token is within the expiry skew window", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: "at-1", expires_in: 3600 }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "at-2", expires_in: 3600 }));
    let clock = 0;
    const tm = createTokenManager({ oauth: REFRESH_OAUTH, fetch, now: () => clock });
    expect(await tm.getAuthHeader()).toBe("Bearer at-1");
    clock = 3600 * 1000; // at/after expiry
    expect(await tm.getAuthHeader()).toBe("Bearer at-2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("single-flights N concurrent expired calls into exactly one refresh", async () => {
    let resolve!: (r: Response) => void;
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolve = res;
        }),
    );
    const tm = createTokenManager({ oauth: REFRESH_OAUTH, fetch, now: () => 0 });
    const calls = Promise.all([tm.getAuthHeader(), tm.getAuthHeader(), tm.getAuthHeader()]);
    // All three should be waiting on the single in-flight fetch.
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(tokenResponse({ access_token: "at-1", expires_in: 3600 }));
    const headers = await calls;
    expect(headers).toEqual(["Bearer at-1", "Bearer at-1", "Bearer at-1"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces the next call to refresh", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: "at-1", expires_in: 3600 }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "at-2", expires_in: 3600 }));
    const tm = createTokenManager({ oauth: REFRESH_OAUTH, fetch, now: () => 0 });
    expect(await tm.getAuthHeader()).toBe("Bearer at-1");
    tm.invalidate();
    expect(await tm.getAuthHeader()).toBe("Bearer at-2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws a scrubbed TokenRefreshError on an HTTP error (no token leak)", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        tokenResponse({ error: "invalid_grant", refresh_token: "rtok-initial" }, 401),
      );
    const tm = createTokenManager({ oauth: REFRESH_OAUTH, fetch, now: () => 0 });
    await expect(tm.getAuthHeader()).rejects.toBeInstanceOf(TokenRefreshError);
    try {
      await tm.getAuthHeader();
    } catch (e) {
      const err = e as TokenRefreshError;
      expect(err.message).not.toContain("rtok-initial");
      expect(err.message).not.toContain("csecret-456");
      expect(err.httpStatus).toBe(401);
    }
  });

  it("client_credentials body has no refresh_token and includes scope + audience", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "at-1", expires_in: 3600 }));
    const tm = createTokenManager({ oauth: CC_OAUTH, fetch, now: () => 0 });
    await tm.getAuthHeader();
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("refresh_token")).toBeNull();
    expect(body.get("scope")).toBe("models.read");
    expect(body.get("audience")).toBe("https://api.test");
  });

  it("adopts a rotated refresh_token and exposes live secrets for redaction", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "at-1", expires_in: 3600, refresh_token: "rtok-rotated" }),
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: "at-2", expires_in: 3600 }));
    const tm = createTokenManager({ oauth: REFRESH_OAUTH, fetch, now: () => 0 });
    await tm.getAuthHeader();
    expect(tm.currentSecrets()).toContain("at-1");
    expect(tm.currentSecrets()).toContain("rtok-rotated");
    tm.invalidate();
    await tm.getAuthHeader();
    // Second refresh must have used the ROTATED token, not the initial one.
    const secondBody = new URLSearchParams(fetch.mock.calls[1]?.[1]?.body as string);
    expect(secondBody.get("refresh_token")).toBe("rtok-rotated");
  });

  it("surfaces a network error as a scrubbed TokenRefreshError", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED https://oauth.test/token"));
    const tm = createTokenManager({ oauth: REFRESH_OAUTH, fetch, now: () => 0 });
    await expect(tm.getAuthHeader()).rejects.toBeInstanceOf(TokenRefreshError);
  });
});
