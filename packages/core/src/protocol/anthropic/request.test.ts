import { describe, expect, it } from "vitest";
import { IRRequestSchema } from "../ir.js";
import { transformRequestOut } from "./request.js";

// Anthropic Messages -> IR inbound normalization (docs/05, task protocol.anthropic-req).
// Anthropic's wire shape diverges structurally from the OpenAI-shaped IR hub:
//   - `system` lives at the top level, not as messages[0]
//   - tool_result / tool_use are content blocks, not their own roles
//   - thinking blocks carry a signature
//   - consecutive same-role messages are forbidden downstream (must be merged)
// transformRequestOut flattens all of this so routing/providers see ONE shape.
// Pure function: no network, no framework. Output is a valid IRRequest.

describe("anthropic transformRequestOut", () => {
  // Rule 1+2+3+5: a mixed request exercising system, text, image, tool_use,
  // tool_result in one shot.
  it("normalizes a mixed system+text+image+tool_use+tool_result request", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 1024,
      system: "be terse",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check the weather" },
            {
              type: "tool_use",
              id: "toolu_abc",
              name: "get_weather",
              input: { city: "SF" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc",
              content: "72F sunny",
            },
          ],
        },
      ],
    };

    const ir = transformRequestOut(req);
    // Output must be a structurally valid IR.
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();

    // Rule 1: system hoisted to the head as role:"system".
    expect(ir.messages[0]).toEqual({ role: "system", content: "be terse" });

    // Rule 5: image becomes an IR image part carrying a data-url + mediaType.
    const userMsg = ir.messages[1];
    expect(userMsg?.role).toBe("user");
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const parts = userMsg?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "text", text: "what is in this image?" });
    expect(parts[1]).toMatchObject({
      type: "image",
      mediaType: "image/png",
    });
    expect((parts[1] as { url: string }).url).toContain("iVBORw0KGgo=");

    // Rule 3: tool_use lifted into assistant.tool_calls (arguments = JSON string).
    const assistantMsg = ir.messages[2];
    expect(assistantMsg?.role).toBe("assistant");
    expect(assistantMsg?.tool_calls).toEqual([
      {
        id: "toolu_abc",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ]);

    // Rule 2: tool_result becomes a standalone role:"tool" with matching id.
    const toolMsg = ir.messages[3];
    expect(toolMsg?.role).toBe("tool");
    expect(toolMsg?.tool_call_id).toBe("toolu_abc");
    expect(toolMsg?.content).toBe("72F sunny");
  });

  // Rule 6: consecutive same-role messages must be merged.
  it("merges consecutive same-role messages", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "world" }] },
      ],
    };

    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();

    // Two adjacent user turns collapse into one.
    const userMsgs = ir.messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const parts = userMsgs[0]?.content as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
    // No two adjacent messages share a role.
    for (let i = 1; i < ir.messages.length; i++) {
      expect(ir.messages[i]?.role).not.toBe(ir.messages[i - 1]?.role);
    }
  });

  // Rule 6 (tool_result fan-out): multiple tool_results in one user turn expand
  // to adjacent role:"tool" messages — these must NOT be merged (distinct ids).
  it("keeps multiple tool_result messages distinct (not merged) by id", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "a" },
            { type: "tool_result", tool_use_id: "toolu_2", content: "b" },
          ],
        },
      ],
    };

    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    const toolMsgs = ir.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]?.tool_call_id).toBe("toolu_1");
    expect(toolMsgs[1]?.tool_call_id).toBe("toolu_2");
  });

  // Rule 4: thinking + signature kept in the IR extension, not normal content.
  it("preserves thinking + signature in the IR extension field", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "step 1: reason", signature: "sig-xyz" },
            { type: "text", text: "the answer is 42" },
          ],
        },
      ],
    };

    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();

    // thinking must NOT appear in the assistant's normal content parts.
    const assistantMsg = ir.messages.find((m) => m.role === "assistant");
    const parts = assistantMsg?.content as Array<Record<string, unknown>>;
    expect(parts).toEqual([{ type: "text", text: "the answer is 42" }]);

    // It is retained in the thinking extension with text + signature.
    expect(ir.thinking).toEqual([
      { type: "thinking", text: "step 1: reason", signature: "sig-xyz" },
    ]);
  });

  it("preserves redacted_thinking blocks too", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "encrypted-blob" },
            { type: "text", text: "ok" },
          ],
        },
      ],
    };
    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    expect(ir.thinking).toHaveLength(1);
  });

  // Rule 7: tools input_schema -> function.parameters; cross-cutting fields pass through.
  it("maps tools input_schema to function.parameters and passes through cross-cutting fields", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 512,
      temperature: 0.4,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "get_weather",
          description: "Get the weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    };

    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    expect(ir.max_tokens).toBe(512);
    expect(ir.temperature).toBe(0.4);
    expect(ir.stream).toBe(true);
    expect(ir.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
  });

  // Rule 1: system as a block[] becomes multipart content.
  it("hoists a block-array system prompt into multipart system content", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 128,
      system: [
        { type: "text", text: "you are helpful" },
        { type: "text", text: "be concise" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };

    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    expect(ir.messages[0]?.role).toBe("system");
    expect(ir.messages[0]?.content).toEqual([
      { type: "text", text: "you are helpful" },
      { type: "text", text: "be concise" },
    ]);
  });

  // Degenerate inputs: no system, no tools, plain string content.
  it("handles degenerate input (no system, no tools, string content)", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      messages: [{ role: "user", content: "ping" }],
    };

    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    expect(ir.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(ir.tools).toBeUndefined();
    expect(ir.thinking).toBeUndefined();
  });

  // fail-open: an unknown content block degrades to a text placeholder, never throws.
  it("degrades unknown content block types to a text placeholder (fail-open)", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [{ type: "some_future_block", foo: "bar" }],
        },
      ],
    };

    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    const parts = ir.messages[0]?.content as Array<Record<string, unknown>>;
    expect(parts[0]?.type).toBe("text");
  });

  // fail-closed on a structurally invalid request (missing required fields).
  it("throws on a structurally invalid request", () => {
    expect(() => transformRequestOut({ messages: [] })).toThrow();
  });
});
