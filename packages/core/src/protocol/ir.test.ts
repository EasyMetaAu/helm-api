import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { IRContentPartSchema, IRMessageSchema, IRRequestSchema, IRResponseSchema } from "./ir.js";

// IR = the single central representation (docs/05). It takes the OpenAI Chat
// shape as its skeleton and extends it with optional fields (multipart typed
// content, thinking+signature, tool-call IDs, cache_control) plus a
// `provider_raw` passthrough bag. These tests pin the load-bearing contracts:
// lossless OpenAI round-trip, fail-closed parsing, and provider_raw catchall.

describe("IRRequestSchema — OpenAI-shape skeleton", () => {
  it("parses the minimal valid OpenAI shape (model + one string user message)", () => {
    const parsed = IRRequestSchema.parse({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(parsed.model).toBe("gpt-4o");
    expect(parsed.messages[0]?.content).toBe("hello");
  });

  it("fails closed (ZodError) when `model` is missing", () => {
    expect(() => IRRequestSchema.parse({ messages: [{ role: "user", content: "x" }] })).toThrow(
      ZodError,
    );
  });

  it("fails closed (ZodError) when `messages` is missing", () => {
    expect(() => IRRequestSchema.parse({ model: "gpt-4o" })).toThrow(ZodError);
  });

  it("round-trips a full OpenAI-shape request losslessly", () => {
    const input = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "2+2?" },
      ],
      temperature: 0.2,
      max_tokens: 64,
      stream: true,
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      tool_choice: "auto",
      response_format: { type: "json_object" },
    } as const;
    const parsed = IRRequestSchema.parse(input);
    expect(parsed).toEqual(input);
  });
});

describe("IRContentPartSchema — multipart typed content", () => {
  it("parses a message with text + image + thinking parts", () => {
    const parsed = IRMessageSchema.parse({
      role: "assistant",
      content: [
        { type: "text", text: "here" },
        {
          type: "image",
          url: "https://example.com/a.png",
          mediaType: "image/png",
          detail: "high",
        },
        { type: "thinking", text: "let me reason", signature: "sig-123" },
      ],
    });
    expect(Array.isArray(parsed.content)).toBe(true);
    expect(Array.isArray(parsed.content) ? parsed.content[1] : undefined).toMatchObject({
      type: "image",
      detail: "high",
    });
  });

  it("rejects an unknown content part `type` via discriminatedUnion", () => {
    expect(() => IRContentPartSchema.parse({ type: "hologram", url: "x" })).toThrow(ZodError);
  });

  it("parses the new multimodal part types (audio / video / document)", () => {
    expect(IRContentPartSchema.parse({ type: "audio", data: "AAAA", format: "wav" }).type).toBe(
      "audio",
    );
    expect(
      IRContentPartSchema.parse({ type: "video", url: "gs://b/v.mp4", fps: 2, startOffset: "0s" })
        .type,
    ).toBe("video");
    expect(
      IRContentPartSchema.parse({ type: "document", data: "JVBER", mediaType: "application/pdf" })
        .type,
    ).toBe("document");
  });
});

describe("IRRequestSchema — litellm parity request params (all optional)", () => {
  it("carries sampling + control params without stripping", () => {
    const input = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      top_p: 0.9,
      top_k: 40,
      frequency_penalty: 0.5,
      presence_penalty: -0.5,
      seed: 7,
      stop: ["\n\n", "STOP"],
      n: 1,
      logprobs: true,
      top_logprobs: 5,
      parallel_tool_calls: false,
      stream_options: { include_usage: true },
      modalities: ["text", "audio"],
      user: "u-123",
      service_tier: "auto",
      reasoning_effort: "high",
    } as const;
    const parsed = IRRequestSchema.parse(input);
    expect(parsed.top_p).toBe(0.9);
    expect(parsed.stop).toEqual(["\n\n", "STOP"]);
    expect(parsed.stream_options?.include_usage).toBe(true);
    expect(parsed.modalities).toContain("audio");
    expect(parsed.reasoning_effort).toBe("high");
  });

  it("accepts a bare string `stop`", () => {
    const parsed = IRRequestSchema.parse({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      stop: "END",
    });
    expect(parsed.stop).toBe("END");
  });

  it("accepts extended reasoning_effort tiers and clamps unknowns to high (litellm parity)", () => {
    // Tolerant passthrough: known tiers (incl. none/xhigh/max) round-trip losslessly...
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const parsed = IRRequestSchema.parse({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        reasoning_effort: effort,
      });
      expect(parsed.reasoning_effort).toBe(effort);
    }
    // ...and an unrecognized FUTURE tier clamps to "high" instead of 400ing the request
    // (the over-strict enum is exactly what broke Codex with effort:"xhigh").
    const clamped = IRRequestSchema.parse({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      reasoning_effort: "ultra",
    });
    expect(clamped.reasoning_effort).toBe("high");
  });
});

describe("IRMessageSchema — litellm parity response fields", () => {
  it("carries reasoning_content, thinking_blocks, annotations, images, audio", () => {
    const parsed = IRMessageSchema.parse({
      role: "assistant",
      content: "answer",
      reasoning_content: "let me think",
      thinking_blocks: [{ type: "thinking", thinking: "step", signature: "sig" }],
      annotations: [
        { type: "url_citation", url: "https://x", title: "X", start_index: 0, end_index: 5 },
      ],
      images: [{ b64_json: "AAAA", mediaType: "image/png" }],
      audio: { id: "a1", data: "BBBB", transcript: "hello", expires_at: 1000 },
    });
    expect(parsed.reasoning_content).toBe("let me think");
    expect(parsed.thinking_blocks?.[0]?.signature).toBe("sig");
    expect(parsed.annotations?.[0]?.url).toBe("https://x");
    expect(parsed.images?.[0]?.b64_json).toBe("AAAA");
    expect(parsed.audio?.transcript).toBe("hello");
  });
});

describe("IRUsageSchema / IRChoiceSchema — litellm parity usage + logprobs", () => {
  it("carries token detail breakdown and reasoning/cache-creation tokens", () => {
    const parsed = IRResponseSchema.parse({
      id: "r",
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
          logprobs: { content: [{ token: "hi", logprob: -0.1, top_logprobs: [] }] },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        cached_tokens: 4,
        reasoning_tokens: 2,
        cache_creation_tokens: 3,
        prompt_tokens_details: { text_tokens: 6, cached_tokens: 4, image_tokens: 0 },
        completion_tokens_details: { text_tokens: 3, reasoning_tokens: 2 },
      },
    });
    expect(parsed.usage?.reasoning_tokens).toBe(2);
    expect(parsed.usage?.prompt_tokens_details?.text_tokens).toBe(6);
    expect(parsed.choices[0]?.logprobs?.content?.[0]?.token).toBe("hi");
  });
});

describe("IRResponseSchema — provider_raw passthrough bag", () => {
  it("preserves declared provider_raw fields AND undeclared ones (catchall)", () => {
    const parsed = IRResponseSchema.parse({
      id: "resp_1",
      model: "claude-3-5-sonnet",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      provider_raw: { stop_reason: "end_turn", usage: { input_tokens: 10 }, x_custom: 1 },
    });
    expect(parsed.provider_raw?.stop_reason).toBe("end_turn");
    // undeclared key survives because of .catchall(z.unknown())
    expect((parsed.provider_raw as Record<string, unknown>).x_custom).toBe(1);
  });

  it("keeps mapped finish_reason and raw stop_reason on independent tracks", () => {
    const parsed = IRResponseSchema.parse({
      id: "resp_2",
      model: "gemini-2.0",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "done" },
          // mapped legal enum value (transformer's job); arbitrary string allowed
          finish_reason: "tool_calls",
        },
      ],
      // raw upstream value lives untouched here
      provider_raw: { stop_reason: "MAX_TOKENS" },
    });
    expect(parsed.choices[0]?.finish_reason).toBe("tool_calls");
    expect(parsed.provider_raw?.stop_reason).toBe("MAX_TOKENS");
    // they do not overwrite each other
    expect(parsed.choices[0]?.finish_reason).not.toBe(parsed.provider_raw?.stop_reason);
  });

  it("accepts a null finish_reason (mid-stream / not yet decided)", () => {
    const parsed = IRResponseSchema.parse({
      id: "r",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: null }],
    });
    expect(parsed.choices[0]?.finish_reason).toBeNull();
  });
});

describe("IRMessageSchema — tool message constraints", () => {
  it("parses a role=tool message carrying tool_call_id", () => {
    const parsed = IRMessageSchema.parse({
      role: "tool",
      content: "42",
      tool_call_id: "call_abc",
    });
    expect(parsed.tool_call_id).toBe("call_abc");
  });

  it("requires tool_calls[].function.arguments to be a JSON string, not an object", () => {
    const ok = IRMessageSchema.parse({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
      ],
    });
    expect(ok.tool_calls?.[0]?.function.arguments).toBe('{"q":"x"}');

    expect(() =>
      IRMessageSchema.parse({
        role: "assistant",
        content: null,
        tool_calls: [
          // arguments as an object must be rejected — IR holds the JSON string
          { id: "call_1", type: "function", function: { name: "search", arguments: { q: "x" } } },
        ],
      }),
    ).toThrow(ZodError);
  });
});
