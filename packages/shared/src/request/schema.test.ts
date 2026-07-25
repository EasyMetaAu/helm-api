import { describe, expect, it } from "vitest";
import { InternalRequestSchema, ProtocolSchema, TargetProviderProtocolSchema } from "./schema.js";

// Minimal valid normalized request: every optional field is explicitly present
// (nullable, not omitted) per the "fields always present" contract.
function validRequest() {
  return {
    request_id: "req_1",
    protocol: "openai_chat",
    account_id: "acct_1",
    api_key_id: "key_1",
    user_id: null,
    org_id: null,
    requested_model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: null,
    stream: false,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
  };
}

describe("InternalRequestSchema", () => {
  it("accepts a minimal valid normalized request", () => {
    const input = validRequest();
    const parsed = InternalRequestSchema.parse(input);
    expect(parsed.request_id).toBe("req_1");
    expect(parsed.protocol).toBe("openai_chat");
    expect(parsed.tools).toBeNull();
    expect(parsed.metadata.memory_mode).toBe("off");
  });

  it("keeps optional client trace_id separate from the internal request_id", () => {
    const base = validRequest();
    const input = { ...base, metadata: { ...base.metadata, trace_id: "client-trace" } };
    const parsed = InternalRequestSchema.parse(input);
    expect(parsed.request_id).toBe("req_1");
    expect(parsed.metadata.trace_id).toBe("client-trace");
  });

  it.each([
    "request_id",
    "protocol",
    "account_id",
    "api_key_id",
    "requested_model",
    "messages",
    "stream",
    "metadata",
  ])("rejects when required field %s is missing", (field) => {
    const input = validRequest() as Record<string, unknown>;
    delete input[field];
    const res = InternalRequestSchema.safeParse(input);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === field)).toBe(true);
    }
  });

  it("enforces the protocol enum", () => {
    expect(InternalRequestSchema.safeParse(validRequest()).success).toBe(true);
    const bad = { ...validRequest(), protocol: "cohere" };
    const res = InternalRequestSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["protocol"]);
    }
  });

  it("enforces the memory_mode enum", () => {
    const ok = validRequest();
    ok.metadata.memory_mode = "inject";
    expect(InternalRequestSchema.safeParse(ok).success).toBe(true);

    const bad = validRequest();
    (bad.metadata as Record<string, unknown>).memory_mode = "on";
    const res = InternalRequestSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["metadata", "memory_mode"]);
    }
  });

  it("treats nullable fields as present-but-nullable (null ok, missing rejected)", () => {
    const withNull = validRequest();
    expect(InternalRequestSchema.safeParse(withNull).success).toBe(true);

    const missing = validRequest() as Record<string, unknown>;
    delete missing.tools;
    expect(InternalRequestSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects an empty messages array", () => {
    const bad = { ...validRequest(), messages: [] };
    const res = InternalRequestSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["messages"]);
    }
  });

  it("accepts an empty native Responses continuation", () => {
    const continuation = {
      ...validRequest(),
      protocol: "openai_responses",
      messages: [],
      provider_raw: { previous_response_id: "resp-1" },
      metadata: {
        ...validRequest().metadata,
        stateful_provider_alias: "openai-codex/gpt-5.6-sol",
      },
      native_request: {
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", input: [], previous_response_id: "resp-1" },
        headers: {},
        mutations: {},
      },
    };

    expect(InternalRequestSchema.safeParse(continuation).success).toBe(true);
  });

  it("accepts a strict empty native Responses prewarm", () => {
    const prewarm = {
      ...validRequest(),
      protocol: "openai_responses",
      messages: [],
      provider_raw: { generate: false },
      native_request: {
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", input: [], generate: false },
        headers: {},
        mutations: {},
      },
    };

    expect(InternalRequestSchema.safeParse(prewarm).success).toBe(true);
  });

  it("rejects an empty continuation whose native and normalized ids disagree", () => {
    const bad = {
      ...validRequest(),
      protocol: "openai_responses",
      messages: [],
      provider_raw: { previous_response_id: "resp-other" },
      metadata: {
        ...validRequest().metadata,
        stateful_provider_alias: "openai-codex/gpt-5.6-sol",
      },
      native_request: {
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", input: [], previous_response_id: "resp-1" },
        headers: {},
        mutations: {},
      },
    };

    expect(InternalRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty native Responses request without a continuation id", () => {
    const bad = {
      ...validRequest(),
      protocol: "openai_responses",
      messages: [],
      native_request: {
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", input: [] },
        headers: {},
        mutations: {},
      },
    };

    expect(InternalRequestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty prewarm whose normalized generate flag is missing", () => {
    const bad = {
      ...validRequest(),
      protocol: "openai_responses",
      messages: [],
      native_request: {
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", input: [], generate: false },
        headers: {},
        mutations: {},
      },
    };

    expect(InternalRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("TargetProviderProtocolSchema", () => {
  it("is a provider wire protocol enum independent from the inbound ProtocolSchema", () => {
    expect(TargetProviderProtocolSchema).not.toBe(ProtocolSchema);
    expect(TargetProviderProtocolSchema.options).toEqual([
      "openai_chat",
      "anthropic_messages",
      "openai_responses",
      "gemini",
    ]);
  });
});
