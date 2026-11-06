import { createNativePassthroughCarrier } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { ConfigStore } from "../store/ports.js";
import { createAnthropicClient } from "./anthropic.js";
import { createAnthropicAccountProfileResolver } from "./anthropic-account-profile.js";
import { createOAuthPoolClient } from "./oauth/pool.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function configStore(): ConfigStore {
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
function body(session = "business-a", account = "") {
  return {
    model: "claude-test",
    max_tokens: 32,
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.300.abc; cc_entrypoint=sdk-cli;",
      },
    ],
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "history", signature: "keep-signed-history" }],
      },
      { role: "user", content: "continue" },
    ],
    metadata: {
      user_id: JSON.stringify({
        account_uuid: account,
        device_id: "incoming-device",
        session_id: session,
      }),
    },
  };
}
function response() {
  return Response.json({
    id: "m",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}
const context = {
  owner: ["tenant", "key-a"] as [string, string],
  requestId: "request-1",
  sessionId: null,
};

describe("Anthropic OAuth account wire identity", () => {
  it.each([
    false,
    true,
  ])("changes credentials and all managed identity after quota rejection (stream=%s)", async (stream) => {
    const store = configStore();
    const resolve = createAnthropicAccountProfileResolver(store);
    await resolve(B, "2.3.10");
    let exhausted = false;
    const calls: { account: string; body: ReturnType<typeof body>; headers: Headers }[] = [];
    const members = [A, B].map((account, index) => ({
      account,
      anthropicAccountUuid: account,
      priority: index,
      schedulable: true,
      client: createAnthropicClient({
        config: {
          baseUrl: "https://api.anthropic.com",
          getAuthHeader: async () => `Bearer credential-${account}`,
          currentMetadata: () => ({ anthropicAccountUuid: account }),
          resolveAccountProfile: resolve,
        },
        fetch: async (_url, init) => {
          calls.push({
            account,
            body: JSON.parse(String(init?.body)),
            headers: new Headers(init?.headers),
          });
          if (account === A && exhausted)
            return Response.json(
              { type: "error", error: { type: "rate_limit_error", message: "usage limit" } },
              { status: 429, headers: { "retry-after": "60" } },
            );
          return stream
            ? new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
                headers: { "content-type": "text/event-stream" },
              })
            : response();
        },
      }),
    }));
    const pool = createOAuthPoolClient({ members, selectionStrategy: "balanced" });
    const original = body();
    const input = createNativePassthroughCarrier({
      protocol: "anthropic_messages",
      body: { ...original, stream },
      rawBody: JSON.stringify({ ...original, stream }),
      headers: {
        "user-agent": "claude-cli/2.2.10 (external, sdk-cli)",
        "x-claude-code-agent-id": "agent-1",
        "x-claude-code-parent-agent-id": "parent-1",
        "x-claude-code-prompt-id": "prompt-1",
        "x-client-request-id": "request-client-1",
        authorization: "Bearer inbound-must-not-forward",
      },
    });
    const invoke = async () => {
      if (stream) {
        for await (const _ of pool.nativePassthroughStream?.(input, {
          anthropicIdentityContext: context,
        }) ?? []) {
          /* consume */
        }
      } else await pool.nativePassthrough?.(input, { anthropicIdentityContext: context });
    };
    await invoke();
    await invoke();
    exhausted = true;
    await invoke();
    await invoke();
    expect(calls.map((call) => call.account)).toEqual([A, A, A, B, B]);
    const ids = calls.map((call) => JSON.parse(call.body.metadata.user_id));
    expect(ids[0]).toEqual(ids[2]);
    expect(ids[3]).toEqual(ids[4]);
    expect(ids[0].device_id).not.toBe(ids[3].device_id);
    expect(ids[0].session_id).not.toBe(ids[3].session_id);
    for (const [index, call] of calls.entries()) {
      expect(call.headers.get("authorization")).toBe(`Bearer credential-${call.account}`);
      expect(call.headers.get("x-api-key")).toBeNull();
      expect(ids[index].account_uuid).toBe(call.account);
      expect(call.headers.get("x-claude-code-session-id")).toBe(ids[index].session_id);
      expect(call.body.messages).toEqual(original.messages);
      const version = call.account === A ? "2.2.10" : "2.3.10";
      expect(call.headers.get("user-agent")).toBe(`claude-cli/${version} (external, cli)`);
      expect(call.body.system[0]?.text).toContain(`cc_version=${version}.abc; cc_entrypoint=cli;`);
    }
    for (const name of [
      "x-claude-code-agent-id",
      "x-claude-code-parent-agent-id",
      "x-claude-code-prompt-id",
      "x-client-request-id",
    ]) {
      expect(calls[2]?.headers.get(name)).not.toBe(calls[3]?.headers.get(name));
    }
    expect(JSON.parse(original.metadata.user_id).account_uuid).toBe("");
  });
  it("isolates A -> B -> A without mutating input, updates raw body and headers, and retains the highest version", async () => {
    const store = configStore();
    const resolver = createAnthropicAccountProfileResolver(store);
    const calls: { body: ReturnType<typeof body>; headers: Headers }[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return response();
    });
    const client = (account: string) =>
      createAnthropicClient({
        config: {
          baseUrl: "https://api.anthropic.com",
          getAuthHeader: async () => `Bearer ${account}`,
          currentMetadata: () => ({ anthropicAccountUuid: account }),
          resolveAccountProfile: resolver,
        },
        fetch: fetcher,
      });
    const original = body();
    const carrier = createNativePassthroughCarrier({
      protocol: "anthropic_messages",
      body: original,
      rawBody: JSON.stringify(original),
      headers: {
        "user-agent": "claude-cli/2.2.10 (external, sdk-cli)",
        "x-claude-code-session-id": "business-a",
        "x-session-id": "business-a",
        "x-claude-code-agent-id": "agent-root",
        "x-claude-code-prompt-id": "prompt-1",
        "x-client-request-id": "request-client-1",
        "x-stainless-package-version": "0.128.0",
        "x-anthropic-additional-protection": "keep",
      },
    });
    const capture = vi.fn();
    const inputSnapshot = structuredClone(carrier);
    await client(A).nativePassthrough?.(carrier, {
      anthropicIdentityContext: context,
      captureUpstream: capture,
    });
    await client(B).nativePassthrough?.(carrier, { anthropicIdentityContext: context });
    await client(A).nativePassthrough?.(carrier, { anthropicIdentityContext: context });
    const identities = calls.map((c) => JSON.parse(c.body.metadata.user_id));
    expect(identities[0]).toEqual(identities[2]);
    expect(identities[0].device_id).not.toBe(identities[1].device_id);
    expect(identities[0].session_id).not.toBe(identities[1].session_id);
    expect(identities.map((i) => i.account_uuid)).toEqual([A, B, A]);
    for (const [i, call] of calls.entries()) {
      expect(call.body.messages).toEqual(original.messages);
      expect(call.headers.get("x-claude-code-session-id")).toBe(identities[i].session_id);
      expect(call.headers.get("x-session-id")).toBe(identities[i].session_id);
      expect(call.headers.get("user-agent")).toBe("claude-cli/2.2.10 (external, cli)");
      expect(call.body.system[0]?.text).toContain("cc_version=2.2.10.abc;");
      expect(call.body.system[0]?.text).toContain("cc_entrypoint=cli;");
      expect(call.headers.get("x-stainless-package-version")).toBe("0.128.0");
      expect(call.headers.get("x-anthropic-additional-protection")).toBe("keep");
    }
    expect(JSON.parse(capture.mock.calls[0]?.[0] ?? "null")).toEqual(calls[0]?.body);
    expect(carrier.raw_body).toBe(JSON.stringify(original));
    expect(carrier.body).toEqual(inputSnapshot.body);
    expect(carrier.headers).toEqual(inputSnapshot.headers);
    for (const name of [
      "x-claude-code-agent-id",
      "x-claude-code-prompt-id",
      "x-client-request-id",
    ]) {
      expect(calls[0]?.headers.get(name)).toBe(calls[2]?.headers.get(name));
      expect(calls[0]?.headers.get(name)).not.toBe(calls[1]?.headers.get(name));
    }
    expect(JSON.parse(original.metadata.user_id).device_id).toBe("incoming-device");
    await client(A).nativePassthrough?.(body("business-b"), { anthropicIdentityContext: context });
    const other = JSON.parse(calls[3]?.body.metadata.user_id ?? "null");
    expect(other.device_id).toBe(identities[0].device_id);
    expect(other.session_id).not.toBe(identities[0].session_id);
    expect(calls[3]?.headers.get("user-agent")).toContain("2.2.10");
    const newerBilling = body();
    newerBilling.metadata.user_id = JSON.stringify({
      device_id: "other-client-device",
      session_id: "business-a",
    });
    newerBilling.system = [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.3.10.abc; cc_entrypoint=sdk-cli;",
      },
    ];
    await client(A).nativePassthrough?.(
      createNativePassthroughCarrier({
        protocol: "anthropic_messages",
        body: newerBilling,
        headers: {
          "user-agent": "claude-cli/2.1.1 (external, sdk-cli)",
          "x-claude-code-agent-id": "agent-child",
          "x-claude-code-parent-agent-id": "agent-root",
          "x-client-request-id": "request-client-1",
        },
      }),
      { anthropicIdentityContext: { ...context, requestId: "request-2" } },
    );
    expect(JSON.parse(calls[4]?.body.metadata.user_id ?? "null")).toEqual(identities[0]);
    expect(calls[4]?.headers.get("user-agent")).toBe("claude-cli/2.3.10 (external, cli)");
    expect(calls[4]?.headers.get("x-claude-code-parent-agent-id")).toBe(
      calls[0]?.headers.get("x-claude-code-agent-id"),
    );
    expect(calls[4]?.headers.get("x-claude-code-agent-id")).not.toBe(
      calls[0]?.headers.get("x-claude-code-agent-id"),
    );
    expect(calls[4]?.headers.get("x-client-request-id")).not.toBe(
      calls[0]?.headers.get("x-client-request-id"),
    );
    expect((await createAnthropicAccountProfileResolver(store)(A, null)).clientVersion).toBe(
      "2.3.10",
    );
  });

  it("rejects the original account assertion before rewriting or sending", async () => {
    const fetcher = vi.fn(async () => response());
    const resolve = vi.fn(createAnthropicAccountProfileResolver(configStore()));
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer test",
        currentMetadata: () => ({ anthropicAccountUuid: B }),
        resolveAccountProfile: resolve,
      },
      fetch: fetcher,
    });
    await expect(client.nativePassthrough?.(body("conversation", A))).rejects.toMatchObject({
      name: "AnthropicIdentityError",
    });
    await expect(client.chatCompletion(body("conversation", A))).rejects.toMatchObject({
      name: "AnthropicIdentityError",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses unverified credentials even when the request has no account assertion", async () => {
    const fetcher = vi.fn(async () => response());
    const resolve = vi.fn(createAnthropicAccountProfileResolver(configStore()));
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer test",
        currentMetadata: () => ({}),
        resolveAccountProfile: resolve,
      },
      fetch: fetcher,
    });
    await expect(client.nativePassthrough?.(body())).rejects.toMatchObject({
      name: "AnthropicIdentityError",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("scopes shared client sessions by owner and keeps missing-session retries request-local", async () => {
    const identities: { device_id: string; session_id: string }[] = [];
    let first = true;
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer test",
        currentMetadata: () => ({ anthropicAccountUuid: A }),
        resolveAccountProfile: createAnthropicAccountProfileResolver(configStore()),
        onUnauthorized() {},
      },
      fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
        identities.push(JSON.parse(JSON.parse(String(init?.body)).metadata.user_id));
        if (first) {
          first = false;
          return new Response("expired", { status: 401 });
        }
        return response();
      }),
    });
    await client.nativePassthrough?.(body(""));
    await client.nativePassthrough?.(body(""));
    await client.nativePassthrough?.(body(), { anthropicIdentityContext: context });
    await client.nativePassthrough?.(body(), {
      anthropicIdentityContext: { ...context, owner: ["tenant", "key-b"] },
    });
    expect(identities).toHaveLength(5);
    expect(identities[0]).toEqual(identities[1]);
    expect(identities[1]?.session_id).not.toBe(identities[2]?.session_id);
    expect(identities[3]?.session_id).not.toBe(identities[4]?.session_id);
    expect(new Set(identities.map((i) => i.device_id)).size).toBe(1);
  });

  it("preserves the original conversation through translation and across count_tokens, 401 retry and streaming", async () => {
    const calls: { url: string; body: ReturnType<typeof body>; headers: Headers }[] = [];
    let unauthorized = true;
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer test",
        currentMetadata: () => ({ anthropicAccountUuid: A }),
        resolveAccountProfile: createAnthropicAccountProfileResolver(configStore()),
        onUnauthorized() {},
        metadataUserId: JSON.stringify({
          device_id: "legacy-device",
          session_id: "legacy-single-session",
        }),
      },
      fetch: vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        });
        if (String(url).endsWith("count_tokens")) return Response.json({ input_tokens: 1 });
        if (unauthorized) {
          unauthorized = false;
          return new Response("denied", { status: 401 });
        }
        if (JSON.parse(String(init?.body)).stream)
          return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          });
        return response();
      }),
    });
    const upgradedContext = { ...context, clientVersion: "2.2.10" };
    await client.countTokens?.(body(), { anthropicIdentityContext: upgradedContext });
    await client.chatCompletion(body(), { anthropicIdentityContext: upgradedContext });
    for await (const _ of client.nativePassthroughStream?.(
      { ...body(), stream: true },
      { anthropicIdentityContext: upgradedContext },
    ) ?? []) {
      /* consume */
    }
    const identities = calls.map((c) => JSON.parse(c.body.metadata.user_id));
    expect(identities).toHaveLength(4);
    expect(new Set(identities.map((i) => i.session_id)).size).toBe(1);
    expect(new Set(identities.map((i) => i.device_id)).size).toBe(1);
    expect(identities[0].device_id).not.toBe("legacy-device");
    for (const call of calls) {
      expect(call.headers.get("user-agent")).toContain("claude-cli/2.2.10 ");
      expect(call.headers.get("user-agent")).toContain("(external, cli)");
      expect(call.body.system[0]?.text).toContain("cc_version=2.2.10.");
      expect(call.body.system[0]?.text).toContain("cc_entrypoint=cli");
      expect(call.headers.get("x-claude-code-session-id")).toBe(identities[0].session_id);
    }
  });
});
