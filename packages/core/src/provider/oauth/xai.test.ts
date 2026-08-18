import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  discoverOAuthModels,
  hasLiveModelDiscovery,
  listXaiOAuthModels,
  type XaiOAuthModel,
} from "./models.js";
import {
  beginXaiDeviceLogin,
  isTrustedXaiOAuthEndpoint,
  loginXai,
  pollXaiDeviceOnce,
  refreshXaiOAuthToken,
  resolveXaiGrokClientVersion,
  XAI_GROK_CLIENT_VERSION,
  XAI_GROK_CLIENT_VERSION_ENV,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  xaiGrokInferenceHeaders,
  xaiGrokSubscriptionTierHint,
  xaiOAuthProvider,
} from "./xai.js";

const DISCOVERY = {
  token_endpoint: "https://auth.x.ai/oauth2/token",
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/auth",
};

describe("xAI OAuth", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requires every normalized catalog model to carry a context window", () => {
    expectTypeOf<XaiOAuthModel["contextWindow"]>().toEqualTypeOf<number>();
  });

  it("accepts only HTTPS x.ai discovery endpoints", () => {
    expect(isTrustedXaiOAuthEndpoint("https://auth.x.ai/oauth2/token")).toBe(true);
    expect(isTrustedXaiOAuthEndpoint("https://x.ai/oauth/token")).toBe(true);
    expect(isTrustedXaiOAuthEndpoint("http://auth.x.ai/oauth2/token")).toBe(false);
    expect(isTrustedXaiOAuthEndpoint("https://x.ai.evil.test/token")).toBe(false);
  });

  it("builds the first-party Grok CLI inference headers for the resolved wire model", () => {
    expect(XAI_GROK_CLIENT_VERSION).toBe("0.2.101");
    expect(xaiGrokInferenceHeaders("grok-composer-2.5-fast")).toEqual({
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-version": "0.2.101",
      "x-grok-client-identifier": "helm-api",
      "x-grok-client-mode": "headless",
      "x-grok-model-override": "grok-composer-2.5-fast",
    });
    expect(() => xaiGrokInferenceHeaders("   ")).toThrow(/wire model/);
    expect(() => xaiGrokInferenceHeaders("grok-4.5\r\nx-injected: yes")).toThrow(
      /invalid wire model/,
    );
  });

  it("reads only the xAI tier claim as a scheduling hint", () => {
    const token = (tier: unknown) => {
      const payload = Buffer.from(JSON.stringify({ tier })).toString("base64url");
      return `header.${payload}.signature`;
    };
    expect(xaiGrokSubscriptionTierHint(token(0))).toBe("free");
    expect(xaiGrokSubscriptionTierHint(token(2))).toBe("x_basic");
    expect(xaiGrokSubscriptionTierHint(token("SuperGrok Heavy"))).toBe("supergrok_heavy");
    expect(xaiGrokSubscriptionTierHint("opaque-token")).toBeUndefined();
  });

  it("uses a validated operator override for the Grok CLI protocol version", () => {
    expect(resolveXaiGrokClientVersion({})).toBe("0.2.101");
    expect(resolveXaiGrokClientVersion({ [XAI_GROK_CLIENT_VERSION_ENV]: " 0.3.1 " })).toBe("0.3.1");
    expect(
      xaiGrokInferenceHeaders("grok-4.5", {
        [XAI_GROK_CLIENT_VERSION_ENV]: "0.3.1",
      })["x-grok-client-version"],
    ).toBe("0.3.1");
    expect(() =>
      resolveXaiGrokClientVersion({
        [XAI_GROK_CLIENT_VERSION_ENV]: "0.3.1\r\nx-unsafe: injected",
      }),
    ).toThrow(/semantic version/);
    expect(() => resolveXaiGrokClientVersion({ [XAI_GROK_CLIENT_VERSION_ENV]: "latest" })).toThrow(
      /semantic version/,
    );
  });

  it("adds the current OAuth account identity without changing the env argument", () => {
    expect(
      xaiGrokInferenceHeaders(
        "grok-4.5",
        { [XAI_GROK_CLIENT_VERSION_ENV]: "0.3.1" },
        { userId: "xai-user-current" },
      ),
    ).toMatchObject({
      "x-grok-client-version": "0.3.1",
      "x-grok-user-id": "xai-user-current",
    });
    expect(xaiGrokInferenceHeaders("grok-4.5", {}, { userId: "   " })).not.toHaveProperty(
      "x-grok-user-id",
    );
  });

  it("discovers endpoints and starts the device-code flow", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(DISCOVERY))
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/activate",
          verification_uri_complete: "https://auth.x.ai/activate?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 3,
        }),
      );

    const result = await beginXaiDeviceLogin(fetchImpl, () => 1_000);

    expect(result).toMatchObject({
      deviceCode: "device-secret",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.x.ai/activate?user_code=ABCD-EFGH",
      tokenEndpoint: DISCOVERY.token_endpoint,
      expiresAt: 601_000,
      intervalMs: 3_000,
    });
    const body = new URLSearchParams(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(body.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(body.get("scope")).toBe(XAI_OAUTH_SCOPE);
  });

  it("disables automatic redirects for discovery, device authorization, polling, and refresh requests", async () => {
    const beginFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(DISCOVERY))
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/activate",
        }),
      );
    await beginXaiDeviceLogin(beginFetch);

    expect(beginFetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(beginFetch.mock.calls[1]?.[1]?.redirect).toBe("error");

    const pollFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "authorization_pending" }, { status: 400 }));
    await pollXaiDeviceOnce(
      { tokenEndpoint: DISCOVERY.token_endpoint, deviceCode: "device-secret" },
      pollFetch,
    );
    expect(pollFetch.mock.calls[0]?.[1]?.redirect).toBe("error");

    const refreshFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 60,
      }),
    );
    await refreshXaiOAuthToken(
      {
        access: "old-access",
        refresh: "old-refresh",
        expires: 1,
        tokenEndpoint: DISCOVERY.token_endpoint,
      },
      refreshFetch,
    );
    expect(refreshFetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("rejects an untrusted endpoint returned by discovery", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...DISCOVERY,
        token_endpoint: "https://attacker.example/token",
      }),
    );
    await expect(beginXaiDeviceLogin(fetchImpl)).rejects.toThrow("untrusted token endpoint");
  });

  it("returns pending without blocking, then parses a completed token", async () => {
    const pendingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "authorization_pending" }, { status: 400 }));
    await expect(
      pollXaiDeviceOnce(
        { tokenEndpoint: DISCOVERY.token_endpoint, deviceCode: "device-secret" },
        pendingFetch,
      ),
    ).resolves.toEqual({ status: "pending" });

    const doneFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        id_token: "header.eyJlbWFpbCI6Imx1a2luQGV4YW1wbGUuY29tIiwic3ViIjoiYWNjdC0xIn0.sig",
      }),
    );
    const done = await pollXaiDeviceOnce(
      { tokenEndpoint: DISCOVERY.token_endpoint, deviceCode: "device-secret" },
      doneFetch,
      () => 5_000,
    );
    expect(done).toEqual({
      status: "done",
      credentials: expect.objectContaining({
        access: "access",
        refresh: "refresh",
        expires: 3_605_000,
        email: "lukin@example.com",
        accountId: "acct-1",
        tokenEndpoint: DISCOVERY.token_endpoint,
      }),
    });
  });

  it("waits for the advertised interval before polling and increases it after slow_down", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(DISCOVERY))
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/activate",
          expires_in: 60,
          interval: 2,
        }),
      )
      .mockResolvedValueOnce(Response.json({ error: "slow_down" }, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        }),
      );
    vi.stubGlobal("fetch", fetchImpl);

    const onAuth = vi.fn();
    const loginPromise = loginXai({ onAuth, onPrompt: async () => "" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuth).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(loginPromise).resolves.toMatchObject({ access: "access", refresh: "refresh" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not poll when the device code expires while waiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(DISCOVERY))
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/activate",
          expires_in: 2,
          interval: 2,
        }),
      );
    vi.stubGlobal("fetch", fetchImpl);

    const loginPromise = loginXai({ onAuth: () => {}, onPrompt: async () => "" });
    const assertion = expect(loginPromise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rotates refresh tokens and preserves the old token when omitted", async () => {
    const rotated = await refreshXaiOAuthToken(
      {
        access: "old-access",
        refresh: "old-refresh",
        expires: 1,
        tokenEndpoint: DISCOVERY.token_endpoint,
      },
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 60,
        }),
      ),
      () => 10_000,
    );
    expect(rotated).toMatchObject({
      access: "new-access",
      refresh: "new-refresh",
      expires: 70_000,
    });

    const preserved = await refreshXaiOAuthToken(
      rotated,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ access_token: "newer-access", expires_in: 60 })),
      () => 20_000,
    );
    expect(preserved.refresh).toBe("new-refresh");
  });

  it("registers a device-code preset provider", () => {
    expect(xaiOAuthProvider).toMatchObject({
      id: "xai",
      name: expect.stringContaining("Grok"),
      usesCallbackServer: false,
    });
    expect(xaiOAuthProvider.getApiKey({ access: "a", refresh: "r", expires: 1 })).toBe("a");
  });

  it("discovers only valid Responses model ids from the Grok subscription proxy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          { id: "grok-composer-2.5-fast", api_backend: "responses" },
          { id: "grok-4.3", api_backend: "language" },
          { id: "grok-chat", api_backend: "chat" },
          { id: "grok-imagine-image", api_backend: "image" },
          { id: "grok-embed", api_backend: "embeddings" },
          { id: "grok-unknown", api_backend: "future_backend" },
          { id: "grok-legacy-without-backend" },
          { id: "grok-4.5" },
          "grok-legacy-string",
          { id: "" },
          { id: 42 },
        ],
      }),
    );
    await expect(discoverOAuthModels("xai", "oauth-access", fetchImpl)).resolves.toEqual([
      "grok-composer-2.5-fast",
    ]);
    expect(hasLiveModelDiscovery("xai")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer oauth-access" }),
      }),
    );
    const discoveryHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(discoveryHeaders.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
    expect(discoveryHeaders.get("x-authenticateresponse")).toBeNull();
    expect(discoveryHeaders.get("x-grok-client-version")).toBe("0.2.101");
    expect(discoveryHeaders.get("x-grok-client-mode")).toBe("headless");
    expect(discoveryHeaders.get("x-grok-model-override")).toBeNull();
  });

  it("preserves the first-party model catalog shape and exposes only routable Responses ids", async () => {
    const payload = {
      data: [
        {
          id: "catalog-grok",
          model: "wire-grok-2026-07-16",
          name: "Grok Catalog Entry",
          apiBackend: "responses",
          contextWindow: 500_000,
          maxCompletionTokens: 32_768,
          maxRetries: 0,
          supportsReasoningEffort: true,
          reasoningEfforts: [{ id: "quick", value: "low", label: "Quick" }, { value: "high" }],
          streamToolCalls: true,
        },
        { id: "chat-only", model: "chat-wire", apiBackend: "chat_completions" },
        { id: "messages-only", model: "messages-wire", apiBackend: "messages" },
        { id: "hidden", model: "hidden-wire", apiBackend: "responses", hidden: true },
        {
          id: "unsupported",
          model: "unsupported-wire",
          apiBackend: "responses",
          supportedInApi: false,
        },
        { id: "legacy-chat", model: "legacy-wire" },
        { id: "invented", model: "invented-wire", apiBackend: "language" },
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));

    await expect(
      listXaiOAuthModels("opaque-access-token", fetchImpl, {
        identity: { userId: "user-123", email: "l@x.ai" },
      }),
    ).resolves.toEqual([
      {
        id: "catalog-grok",
        model: "wire-grok-2026-07-16",
        name: "Grok Catalog Entry",
        apiBackend: "responses",
        contextWindow: 500_000,
        maxCompletionTokens: 32_768,
        maxRetries: 0,
        hidden: false,
        supportedInApi: true,
        supportsReasoningEffort: true,
        reasoningEfforts: [
          { id: "quick", value: "low", label: "Quick" },
          { id: "high", value: "high", label: "High" },
        ],
        streamToolCalls: true,
      },
      {
        id: "chat-only",
        model: "chat-wire",
        apiBackend: "chat_completions",
        contextWindow: 256_000,
        hidden: false,
        supportedInApi: true,
        supportsReasoningEffort: false,
        reasoningEfforts: [],
      },
      {
        id: "messages-only",
        model: "messages-wire",
        apiBackend: "messages",
        contextWindow: 256_000,
        hidden: false,
        supportedInApi: true,
        supportsReasoningEffort: false,
        reasoningEfforts: [],
      },
      {
        id: "hidden",
        model: "hidden-wire",
        apiBackend: "responses",
        contextWindow: 256_000,
        hidden: true,
        supportedInApi: true,
        supportsReasoningEffort: false,
        reasoningEfforts: [],
      },
      {
        id: "unsupported",
        model: "unsupported-wire",
        apiBackend: "responses",
        contextWindow: 256_000,
        hidden: false,
        supportedInApi: false,
        supportsReasoningEffort: false,
        reasoningEfforts: [],
      },
      {
        id: "legacy-chat",
        model: "legacy-wire",
        apiBackend: "chat_completions",
        contextWindow: 256_000,
        hidden: false,
        supportedInApi: true,
        supportsReasoningEffort: false,
        reasoningEfforts: [],
      },
    ]);
    const catalogHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(catalogHeaders.get("x-userid")).toBe("user-123");
    expect(catalogHeaders.get("x-email")).toBe("l@x.ai");
    expect(catalogHeaders.get("x-grok-client-mode")).toBe("headless");
    expect(catalogHeaders.get("x-authenticateresponse")).toBeNull();
    expect(catalogHeaders.get("x-grok-model-override")).toBeNull();

    await expect(
      discoverOAuthModels(
        "xai",
        "oauth-access",
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
      ),
    ).resolves.toEqual(["catalog-grok", "unsupported"]);
  });

  it("aborts Grok model discovery after its request timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });

    await expect(
      listXaiOAuthModels("oauth-access", fetchImpl, { timeoutMs: 10 }),
    ).rejects.toThrow();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("honours an external abort during Grok model discovery", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = listXaiOAuthModels("oauth-access", fetchImpl, {
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled by caller"));

    await expect(pending).rejects.toThrow("cancelled by caller");
  });

  it("rejects an oversized declared Grok model response without exposing secrets", async () => {
    const token = "secret-bearer-token";
    const bodySecret = "secret-response-body";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(bodySecret, {
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
    );

    const error = await listXaiOAuthModels(token, fetchImpl).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("exceeds 1048576 bytes");
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(bodySecret);
  });

  it("stops streaming a Grok model response once it crosses 1 MiB", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700 * 1024));
        controller.enqueue(new Uint8Array(400 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(responseBody));

    await expect(listXaiOAuthModels("oauth-access", fetchImpl)).rejects.toThrow(
      "exceeds 1048576 bytes",
    );
    expect(cancelled).toBe(true);
  });

  it("keeps model discovery fail-open when a bounded response is rejected", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("private upstream diagnostic", {
        status: 503,
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
    );

    await expect(discoverOAuthModels("xai", "oauth-access", fetchImpl)).resolves.toEqual([]);
  });

  it("does not substitute public API models when subscription discovery fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 503 }));
    await expect(discoverOAuthModels("xai", "oauth-access", fetchImpl)).resolves.toEqual([]);
    await expect(discoverOAuthModels("xai", undefined, fetchImpl)).resolves.toEqual([]);
  });
});
