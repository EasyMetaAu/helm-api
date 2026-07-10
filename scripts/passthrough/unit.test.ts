import { describe, expect, it } from "vitest";
import {
  cloneCarrierWithBody,
  createNativePassthroughCarrier,
  nativePassthroughBody,
  nativePassthroughMutations,
} from "../../packages/shared/src/native-passthrough.js";
import { prepareNativePassthroughRequest } from "../../packages/core/src/provider/native-passthrough.js";
import {
  codexCommandPinsBaseUrl,
  inferredAdminBaseUrl,
  summarizeCliOutput,
} from "./live-cli.js";

describe("native passthrough helper acceptance", () => {
  it("keeps the raw body when no body mutation is required", () => {
    const rawBody = '{"model":"claude-3-5-haiku-latest","unknown":{"b":2,"a":1}}';
    const carrier = createNativePassthroughCarrier({
      protocol: "anthropic_messages",
      body: { model: "claude-3-5-haiku-latest", unknown: { b: 2, a: 1 } },
      rawBody,
      headers: {},
    });

    const cloned = cloneCarrierWithBody(carrier, carrier.body, { preserveRawBody: true });

    expect(nativePassthroughBody(cloned)).toEqual(carrier.body);
    expect(cloned.raw_body).toBe(rawBody);
    expect(nativePassthroughMutations(cloned)).toEqual({});
  });

  it("drops unsafe headers, preserves safe client headers, and records a mutation ledger", () => {
    const carrier = createNativePassthroughCarrier({
      protocol: "openai_responses",
      body: { model: "gpt-5-codex", input: "hi", stream: true },
      rawBody: '{"model":"gpt-5-codex","input":"hi","stream":true}',
      headers: {
        authorization: "Bearer helm-client-key",
        "x-api-key": "client-upstream-key",
        cookie: "sid=client-cookie",
        "x-auth-token": "client-auth-token",
        "x-client-secret": "client-secret",
        "x-helm-trace-id": "trace-client",
        connection: "keep-alive",
        "content-length": "999",
        "user-agent": "codex-cli/0.1.0",
        accept: "text/event-stream",
        originator: "client-originator",
        session_id: "client-session",
        "x-client-request-id": "client-request-id",
        "x-session-id": "sess-client",
        "openai-beta": "client-beta",
      },
    });

    const prepared = prepareNativePassthroughRequest(
      carrier,
      {
        Authorization: "Bearer provider-token",
        accept: "application/json",
        "OpenAI-Beta": "responses=experimental",
        originator: "helm",
        session_id: "provider-session",
        "x-client-request-id": "provider-request-id",
      },
      { mergeHeaders: ["openai-beta"] },
    );

    const headerNames = Object.keys(prepared.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("x-auth-token");
    expect(headerNames).not.toContain("x-client-secret");
    expect(headerNames).not.toContain("x-helm-trace-id");
    expect(headerNames).not.toContain("connection");
    expect(headerNames).not.toContain("content-length");
    expect(prepared.headers.authorization).toBeUndefined();
    expect(prepared.headers.Authorization).toBe("Bearer provider-token");
    expect(prepared.headers["user-agent"]).toBe("codex-cli/0.1.0");
    expect(prepared.headers.accept).toBe("text/event-stream");
    expect(prepared.headers.originator).toBe("client-originator");
    expect(prepared.headers.session_id).toBe("client-session");
    expect(prepared.headers["x-client-request-id"]).toBe("client-request-id");
    expect(prepared.headers["x-session-id"]).toBe("sess-client");
    expect(prepared.headers["OpenAI-Beta"]).toBe("client-beta, responses=experimental");
    expect(prepared.bodyText).toBe(carrier.raw_body);
    expect(carrier.mutations).toMatchObject({
      auth_replaced: true,
      content_length_recomputed: true,
      headers_overwritten: ["openai-beta"],
    });
    expect(carrier.mutations.headers_dropped).toEqual(
      expect.arrayContaining([
        "authorization",
        "connection",
        "content-length",
        "cookie",
        "x-auth-token",
        "x-api-key",
        "x-client-secret",
        "x-helm-trace-id",
      ]),
    );
    expect(JSON.stringify(carrier.mutations)).not.toContain("helm-client-key");
    expect(JSON.stringify(carrier.mutations)).not.toContain("provider-token");
  });

  it("summarizes live CLI output without embedding secrets or full prompts", () => {
    const previousKey = process.env.HELM_PASSTHROUGH_API_KEY;
    const previousToken = process.env.PROVIDER_ACCESS_TOKEN;
    process.env.HELM_PASSTHROUGH_API_KEY = "helm-secret-key-1234";
    process.env.PROVIDER_ACCESS_TOKEN = "provider-secret-token-5678";
    try {
      const summary = summarizeCliOutput(
        'prompt: "Please process private customer data"\nkey=helm-secret-key-1234\nHELM_LIVE_OK\nprovider-secret-token-5678',
        "HELM_LIVE_OK",
      );

      expect(summary).toContain("sentinel_present:true");
      expect(summary).toContain("bytes");
      expect(summary).not.toContain("Please process private customer data");
      expect(summary).not.toContain("helm-secret-key-1234");
      expect(summary).not.toContain("provider-secret-token-5678");
    } finally {
      if (previousKey === undefined) delete process.env.HELM_PASSTHROUGH_API_KEY;
      else process.env.HELM_PASSTHROUGH_API_KEY = previousKey;
      if (previousToken === undefined) delete process.env.PROVIDER_ACCESS_TOKEN;
      else process.env.PROVIDER_ACCESS_TOKEN = previousToken;
    }
  });

  it("requires Codex live commands to pin the Helm base URL through Codex config", () => {
    expect(
      codexCommandPinsBaseUrl(
        `codex exec -c 'openai_base_url="http://127.0.0.1:18080/v1"' -m gpt-5.6-sol hi`,
      ),
    ).toBe(true);
    expect(codexCommandPinsBaseUrl("codex exec -m gpt-5.6-sol hi")).toBe(false);
  });

  it("derives the admin origin from a /v1 API base without producing /v1/admin", () => {
    expect(inferredAdminBaseUrl(undefined, "http://127.0.0.1:18080/v1")).toBe(
      "http://127.0.0.1:18080",
    );
    expect(
      inferredAdminBaseUrl("http://127.0.0.1:19090/", "http://127.0.0.1:18080/v1"),
    ).toBe("http://127.0.0.1:19090");
  });
});
