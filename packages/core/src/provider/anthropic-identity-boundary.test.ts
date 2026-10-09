import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "./anthropic.js";
import { anthropicOAuthProvider, refreshAnthropicToken } from "./oauth/anthropic.js";
import { createOAuthPoolClient } from "./oauth/pool.js";
import { UpstreamError } from "./openai.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const request = (account: string = A) => ({
  model: "claude-test",
  max_tokens: 32,
  messages: [{ role: "user", content: "hello" }],
  metadata: {
    user_id: JSON.stringify({ account_uuid: account, device_id: "device", session_id: "session" }),
  },
});
const response = () =>
  Response.json({
    id: "m",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

describe("Anthropic authenticated account boundary", () => {
  it("preserves a matching source identity through translation", async () => {
    const source = request();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).metadata).toEqual(source.metadata);
      return response();
    });
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer test",
        currentMetadata: () => ({ anthropicAccountUuid: A }),
        metadataUserId: JSON.stringify({ account_uuid: "", device_id: "gateway-device" }),
      },
      fetch: fetcher,
    });
    await client.chatCompletion(source);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not erase explicit account assertions through OAuth translation", async () => {
    const fetcher = vi.fn(async () => response());
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer test",
        currentMetadata: () => ({ anthropicAccountUuid: B }),
      },
      fetch: fetcher,
    });
    await expect(client.chatCompletion(request())).rejects.toMatchObject({
      name: "AnthropicIdentityError",
    });
    await expect(
      (async () => {
        for await (const _ of client.chatCompletionStream(request())) {
        }
      })(),
    ).rejects.toMatchObject({ name: "AnthropicIdentityError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains token account.uuid separately from organization.uuid", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        account: { uuid: A },
        organization: { uuid: B },
      }),
    );
    expect(await refreshAnthropicToken("r", fetcher)).toMatchObject({ anthropicAccountUuid: A });
  });

  it("preserves verified identity when refresh omits it; rejects changed identity", async () => {
    const previous = { access: "a", refresh: "r", expires: 0, anthropicAccountUuid: A };
    const refresh = (account?: { uuid: string }) =>
      vi.fn(async () =>
        Response.json({ access_token: "new-a", refresh_token: "new-r", expires_in: 3600, account }),
      );
    expect(await anthropicOAuthProvider.refreshToken(previous, refresh())).toMatchObject({
      anthropicAccountUuid: A,
    });
    await expect(
      anthropicOAuthProvider.refreshToken(previous, refresh({ uuid: B })),
    ).rejects.toThrow(/identity changed/);
    await expect(
      anthropicOAuthProvider.refreshToken(previous, refresh({ uuid: "invalid" })),
    ).rejects.toThrow();
  });

  it.each([
    B,
    undefined,
    "invalid",
  ])("rejects asserted account against credential %s before dispatch", async (uuid) => {
    const fetcher = vi.fn(async () => response());
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer test",
        currentMetadata: () => ({ anthropicAccountUuid: uuid }),
      },
      fetch: fetcher,
    });
    await expect(client.nativePassthrough?.(request())).rejects.toMatchObject({
      name: "AnthropicIdentityError",
    });
    await expect(client.countTokens?.(request())).rejects.toMatchObject({
      name: "AnthropicIdentityError",
    });
    await expect(
      (async () => {
        for await (const _ of client.nativePassthroughStream?.(request()) ?? []) {
          /* consume */
        }
      })(),
    ).rejects.toMatchObject({ name: "AnthropicIdentityError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks identity after lazy auth loading and preserves matching raw bytes", async () => {
    let uuid: string | undefined;
    const body = request();
    const raw = JSON.stringify(body, null, 2);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.body).toBe(raw);
      return response();
    });
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => {
          uuid = A;
          return "Bearer test";
        },
        currentMetadata: () => ({ anthropicAccountUuid: uuid }),
      },
      fetch: fetcher,
    });
    await client.nativePassthrough?.({
      protocol: "anthropic_messages",
      body,
      raw_body: raw,
      headers: {},
      mutations: {},
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "native",
    "translated",
  ])("rechecks %s identity after 401 refresh without sending to the changed account", async (mode) => {
    let calls = 0;
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { type: "authentication_error", message: "expired" } },
        { status: 401 },
      ),
    );
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => {
          calls++;
          return "Bearer test";
        },
        currentMetadata: () => ({ anthropicAccountUuid: calls === 1 ? A : B }),
        onUnauthorized: () => {},
      },
      fetch: fetcher,
    });
    await expect(
      mode === "native" ? client.nativePassthrough?.(request()) : client.chatCompletion(request()),
    ).rejects.toMatchObject({
      name: "AnthropicIdentityError",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("leaves static API-key and opaque metadata users compatible", async () => {
    const fetcher = vi.fn(async () => response());
    await createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "test" },
      fetch: fetcher,
    }).nativePassthrough?.(request());
    await createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", getAuthHeader: async () => "Bearer test" },
      fetch: fetcher,
    }).nativePassthrough?.({ ...request(), metadata: { user_id: "opaque-application-user" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("selects the asserted account before dispatch and cannot fail over to another UUID", async () => {
    const served: string[] = [];
    let fail = false;
    const members = [B, A].map((uuid) => ({
      account: uuid,
      priority: 50,
      schedulable: true,
      anthropicAccountUuid: uuid,
      client: {
        nativeProtocolProfile: "anthropic_messages" as const,
        chatCompletion: async () => {
          served.push(uuid);
          if (fail) throw new UpstreamError("upstream_error", "busy", null, 429);
          return {};
        },
        chatCompletionStream: async function* () {
          served.push(uuid);
          yield await Promise.reject(new UpstreamError("upstream_error", "busy", null, 503));
        },
        nativePassthrough: async () => {
          served.push(uuid);
          if (fail) throw new UpstreamError("upstream_error", "busy", null, 429);
          return {};
        },
        nativePassthroughStream: async function* () {
          served.push(uuid);
          yield await Promise.reject(new UpstreamError("upstream_error", "busy", null, 503));
        },
      },
    }));
    const pool = createOAuthPoolClient({ members, now: () => 1 });
    await pool.nativePassthrough?.(request());
    fail = true;
    await expect(pool.nativePassthrough?.(request())).rejects.toBeDefined();
    expect(served).toEqual([A, A]);
    const fresh = createOAuthPoolClient({
      members: members.map((m) => ({ ...m, usageLimitedUntilMs: null })),
      now: () => 1,
    });
    await expect(
      (async () => {
        for await (const _ of fresh.nativePassthroughStream?.(request()) ?? []) {
        }
      })(),
    ).rejects.toBeDefined();
    expect(served).toEqual([A, A, A]);
    await expect(
      pool.nativePassthrough?.(request("33333333-3333-4333-8333-333333333333")),
    ).rejects.toMatchObject({ name: "AnthropicIdentityError" });
    const translated = createOAuthPoolClient({
      members: members.map((m) => ({ ...m, usageLimitedUntilMs: null })),
      now: () => 1,
    });
    await expect(translated.chatCompletion(request())).rejects.toBeDefined();
    const translatedStream = createOAuthPoolClient({
      members: members.map((m) => ({ ...m, usageLimitedUntilMs: null })),
      now: () => 1,
    });
    await expect(
      (async () => {
        for await (const _ of translatedStream.chatCompletionStream(request())) {
        }
      })(),
    ).rejects.toBeDefined();
    expect(served).toEqual([A, A, A, A, A]);
  });
});

describe("Anthropic adapter header semantics", () => {
  it("does not invent Stainless SDK version, OS, retry or timeout metadata", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect([...headers.keys()].filter((h) => h.startsWith("x-stainless-"))).toEqual([]);
      return response();
    });
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer test",
        timeoutMs: 1234,
      },
      fetch: fetcher,
    });
    await client.chatCompletion({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves actual native SDK metadata and reviewed optional fields without inventing absent ones", async () => {
    const fields = {
      "anthropic-version": "future-version",
      "anthropic-beta": "future-beta,oauth-2025-04-20",
      "x-app": "cli-bg",
      "x-stainless-package-version": "0.128.0",
      "x-stainless-os": "MacOS",
      "x-claude-code-prompt-id": A,
      "x-claude-code-request-class": "compaction",
      "x-claude-code-agent-type": "custom",
      "x-anthropic-additional-protection": "true",
      "x-client-app": "actual-client",
      "x-claude-code-compaction": "true",
      "x-claude-code-context-compacted": "true",
      "x-claude-code-prev-tool-durations": "1",
    };
    const review = JSON.parse(readFileSync("config/claude-protocol-review.json", "utf8")) as {
      reviewedHeaders: string[];
    };
    expect(review.reviewedHeaders.every((name) => name in fields)).toBe(true);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(fields)) expect(headers.get(key), key).toBe(value);
      expect(headers.get("x-unrelated-token")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-claude-remote-container-id")).toBeNull();
      return response();
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "test" },
      fetch: fetcher,
    });
    await client.nativePassthrough?.({
      protocol: "anthropic_messages",
      body: request(),
      headers: {
        ...fields,
        "x-unrelated-token": "secret",
        cookie: "secret",
        "x-claude-remote-container-id": "private",
      },
      mutations: {},
    });
  });
});
