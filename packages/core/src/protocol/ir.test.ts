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
        { type: "image", url: "https://example.com/a.png", mediaType: "image/png" },
        { type: "thinking", text: "let me reason", signature: "sig-123" },
      ],
    });
    expect(Array.isArray(parsed.content)).toBe(true);
  });

  it("rejects an unknown content part `type` via discriminatedUnion", () => {
    expect(() => IRContentPartSchema.parse({ type: "video", url: "x" })).toThrow(ZodError);
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
