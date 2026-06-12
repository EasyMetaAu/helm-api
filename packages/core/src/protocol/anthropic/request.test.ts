import { describe, expect, it } from "vitest";
import { type IRRequest, IRRequestSchema } from "../ir.js";
import { guardRequestFor, readWarnings } from "../protocol-guards.js";
import {
  transformRequestIn,
  transformRequestInWithWarnings,
  transformRequestOut,
} from "./request.js";

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

  it("places tool_result messages before trailing user text in a mixed user turn", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "a" } },
            { type: "tool_use", id: "toolu_2", name: "lookup", input: { q: "b" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "a" },
            { type: "tool_result", tool_use_id: "toolu_2", content: "b" },
            { type: "text", text: "next question" },
          ],
        },
      ],
    };

    const ir = transformRequestOut(req);
    expect(ir.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(ir.messages[1]).toMatchObject({ role: "tool", tool_call_id: "toolu_1" });
    expect(ir.messages[2]).toMatchObject({ role: "tool", tool_call_id: "toolu_2" });
    expect(ir.messages[3]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "next question" }],
    });
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

    // It is retained as per-message thinking blocks in provider_raw (distinct from
    // the request-level thinking CONFIG, which rides ir.thinking).
    expect(ir.provider_raw?.thinking_blocks).toEqual([
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
    expect(ir.provider_raw?.thinking_blocks).toHaveLength(1);
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

  // Claude Code (and other clients) send injected system content — e.g. MCP server
  // instructions — as a role:"system" MESSAGE in the array, alongside the top-level
  // `system`. A compatible gateway must accept these and fold them into the system
  // prompt (the outbound transform already does — systemFromMessages). Regression for
  // the Claude Code boot failure: `400 invalid_value messages[1].role` (only
  // user/assistant were accepted inbound).
  it('accepts a role:"system" message and folds it into the system prompt', () => {
    const req = {
      model: "claude-opus-4-8",
      max_tokens: 64,
      system: "top-level system",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "# MCP Server Instructions" },
      ],
    };

    // Inbound must NOT throw (the schema previously rejected role:"system").
    const ir = transformRequestOut(req);
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    const systemTexts = ir.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    expect(systemTexts).toContain("top-level system");
    expect(systemTexts).toContain("# MCP Server Instructions");
    expect(ir.messages.some((m) => m.role === "user")).toBe(true);

    // Outbound round-trip: BOTH system chunks fold into the Anthropic `system` param,
    // leaving messages with only user/assistant turns (a valid Anthropic request).
    const out = transformRequestIn(ir);
    expect(out.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    const sys = typeof out.system === "string" ? out.system : JSON.stringify(out.system);
    expect(sys).toContain("top-level system");
    expect(sys).toContain("# MCP Server Instructions");
  });

  // Block-array content on a system message must also map to a system IR message,
  // not silently become a user turn (the block path used to hardcode role:"user").
  it('maps a block-array role:"system" message to a system IR message', () => {
    const ir = transformRequestOut({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "rules here" }] },
      ],
    });
    const sys = ir.messages.find((m) => m.role === "system");
    expect(sys).toBeDefined();
    expect(JSON.stringify(sys?.content)).toContain("rules here");
  });

  // fail-closed on a structurally invalid request (missing required fields).
  it("throws on a structurally invalid request", () => {
    expect(() => transformRequestOut({ messages: [] })).toThrow();
  });

  // —— litellm-parity sampling + control params (P4) ————————————————————————————
  it("maps top_p / top_k through to the IR", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      top_p: 0.9,
      top_k: 40,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.top_p).toBe(0.9);
    expect(ir.top_k).toBe(40);
  });

  it("maps stop_sequences[] -> IR.stop", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      stop_sequences: ["STOP", "END"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.stop).toEqual(["STOP", "END"]);
  });

  it("maps a thinking config {type:enabled,budget_tokens} -> IR.thinking", () => {
    const ir = transformRequestOut({
      model: "claude-3-7-sonnet",
      max_tokens: 64,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("passes service_tier through to the IR", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      service_tier: "standard_only",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.service_tier).toBe("standard_only");
  });

  it("preserves Anthropic-native passthrough params in provider_raw", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      metadata: { user_id: "u-123" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      mcp_servers: [{ type: "url", url: "https://mcp.example/sse", name: "docs" }],
      container: { id: "container_1" },
      speed: "fast",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.provider_raw?.metadata).toEqual({ user_id: "u-123" });
    expect(ir.provider_raw?.context_management).toEqual({
      edits: [{ type: "clear_tool_uses_20250919" }],
    });
    expect(ir.provider_raw?.mcp_servers).toEqual([
      { type: "url", url: "https://mcp.example/sse", name: "docs" },
    ]);
    expect(ir.provider_raw?.container).toEqual({ id: "container_1" });
    expect(ir.provider_raw?.speed).toBe("fast");
    expect(ir.provider_raw?.output_config).toEqual({ effort: "medium" });
  });

  it("preserves top-level cache_control for automatic prompt caching", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      cache_control: { type: "ephemeral" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.cache_control).toEqual({ type: "ephemeral" });

    const out = transformRequestIn(ir);
    expect(out.cache_control).toEqual({ type: "ephemeral" });
  });

  it("drops top-level automatic cache_control when explicit block/tool cache controls exist", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      cache_control: { type: "ephemeral" },
      tools: [
        {
          name: "lookup",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "long context", cache_control: { type: "ephemeral" } }],
        },
      ],
    });

    const out = transformRequestIn(ir);
    expect(out.cache_control).toBeUndefined();
    const block = out.messages[0]?.content[0] as { cache_control?: unknown };
    expect(block.cache_control).toEqual({ type: "ephemeral" });
    expect(out.tools?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("preserves tool cache_control through Anthropic tool mapping", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      tools: [
        {
          name: "lookup",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.tools?.[0]).toMatchObject({ cache_control: { type: "ephemeral" } });

    const out = transformRequestIn(ir);
    expect(out.tools?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  // Codex P2: a prompt-cache breakpoint placed on a top-level `system` block must
  // survive the round-trip — system blocks are a common cache breakpoint site.
  it("preserves cache_control on a top-level system block (round-trip)", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      system: [{ type: "text", text: "big system prompt", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    const sysContent = ir.messages[0]?.content as Array<Record<string, unknown>>;
    expect(sysContent[0]).toMatchObject({ cache_control: { type: "ephemeral" } });

    const out = transformRequestIn(ir);
    // Must stay a block array (not collapse to a bare string, which has no cache_control).
    expect(Array.isArray(out.system)).toBe(true);
    const block = (out.system as Array<{ cache_control?: unknown }>)[0];
    expect(block?.cache_control).toEqual({ type: "ephemeral" });
  });

  // order 13: per-block cache_control must be PRESERVED through the IR (not just
  // tolerated) and re-emitted on the outbound block, so prompt-cache breakpoints survive.
  it("preserves per-block cache_control through the IR and round-trips it outbound", () => {
    const ir = transformRequestOut({
      model: "claude-3-5-sonnet",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "long context", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    const parts = ir.messages[0]?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({
      type: "text",
      text: "long context",
      cache_control: { type: "ephemeral" },
    });

    const out = transformRequestIn(ir);
    const block = out.messages[0]?.content[0] as { type: string; cache_control?: unknown };
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });
});

// —— Outbound: IR -> native Anthropic request (P4 additions) ————————————————————
describe("anthropic transformRequestIn — P4 params", () => {
  it("maps IR top_p / top_k onto the outbound request", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      top_p: 0.8,
      top_k: 20,
    });
    expect(out.top_p).toBe(0.8);
    expect(out.top_k).toBe(20);
  });

  it("maps IR.stop (string) -> stop_sequences[]", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      stop: "STOP",
    });
    expect(out.stop_sequences).toEqual(["STOP"]);
  });

  it("maps IR.stop (string[]) -> stop_sequences[]", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      stop: ["A", "B"],
    });
    expect(out.stop_sequences).toEqual(["A", "B"]);
  });

  it("maps IR.thinking config straight onto the outbound thinking param", () => {
    const out = transformRequestIn({
      model: "claude-3-7-sonnet",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("derives a thinking budget from reasoning_effort when no explicit thinking config", () => {
    const out = transformRequestIn({
      model: "claude-3-7-sonnet",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
    });
    expect(out.thinking).toMatchObject({ type: "enabled" });
    expect((out.thinking as { budget_tokens?: number }).budget_tokens).toBeGreaterThan(0);
  });

  // order 9: budget must match litellm exactly (billing impact). Previously bloated
  // 2-4x (low:2048, medium:8192, high:16384). litellm: minimal/low=1024 (the
  // ANTHROPIC_MIN floor), medium=2048, high=4096.
  it("maps reasoning_effort to the exact litellm thinking budget per tier", () => {
    const budget = (effort: IRRequest["reasoning_effort"]) => {
      const out = transformRequestIn({
        model: "claude-3-7-sonnet",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: effort,
      });
      return (out.thinking as { budget_tokens?: number }).budget_tokens;
    };
    expect(budget("minimal")).toBe(1024);
    expect(budget("low")).toBe(1024);
    expect(budget("medium")).toBe(2048);
    expect(budget("high")).toBe(4096);
    // Extended tiers (litellm parity): xhigh=8192, max=16384.
    expect(budget("xhigh")).toBe(8192);
    expect(budget("max")).toBe(16384);
    // `none` disables thinking entirely (no type:"enabled" with a 0 budget).
    const noneOut = transformRequestIn({
      model: "claude-3-7-sonnet",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    });
    expect(noneOut.thinking).toBeUndefined();
  });

  // order 10: client parallel_tool_calls:false -> Anthropic disable_parallel_tool_use.
  it("maps parallel_tool_calls:false to tool_choice.disable_parallel_tool_use (with explicit tool_choice)", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(out.tool_choice).toMatchObject({ type: "auto", disable_parallel_tool_use: true });
  });

  it("synthesizes tool_choice:{type:auto,disable_parallel_tool_use} when only parallel_tool_calls:false is set", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      parallel_tool_calls: false,
    });
    expect(out.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("does not set disable_parallel_tool_use when parallel_tool_calls is true/absent", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(out.tool_choice).toEqual({ type: "auto" });
  });

  // order 11: Anthropic metadata (user_id) stashed inbound in provider_raw must be
  // re-emitted on the outbound request.
  it("re-emits metadata from provider_raw onto the outbound request", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      provider_raw: {
        metadata: { user_id: "u-123" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        mcp_servers: [{ type: "url", url: "https://mcp.example/sse", name: "docs" }],
        container: { id: "container_1" },
        speed: "fast",
        output_config: { effort: "medium" },
      },
    });
    expect((out as { metadata?: unknown }).metadata).toEqual({ user_id: "u-123" });
    expect((out as { context_management?: unknown }).context_management).toEqual({
      edits: [{ type: "clear_tool_uses_20250919" }],
    });
    expect((out as { mcp_servers?: unknown }).mcp_servers).toEqual([
      { type: "url", url: "https://mcp.example/sse", name: "docs" },
    ]);
    expect((out as { container?: unknown }).container).toEqual({ id: "container_1" });
    expect((out as { speed?: unknown }).speed).toBe("fast");
    expect((out as { output_config?: unknown }).output_config).toEqual({ effort: "medium" });
  });

  it("passes IR.service_tier through to the outbound request", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      service_tier: "priority",
    });
    expect(out.service_tier).toBe("priority");
  });

  it("filters unsupported constraint keywords from an outbound output_format schema", () => {
    const out = transformRequestIn({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "result",
          schema: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
            },
          },
        },
      },
    });
    expect(out.output_format?.type).toBe("json_schema");
    const schema = out.output_format?.schema as {
      properties: { tags: Record<string, unknown> };
    };
    // The unsupported minItems/maxItems are dropped (folded into description).
    expect(schema.properties.tags).not.toHaveProperty("minItems");
    expect(schema.properties.tags).not.toHaveProperty("maxItems");
    expect(schema.properties.tags.description).toContain("minimum number of items");
  });
});

describe("anthropic document input (P7 multimodal)", () => {
  // Inbound: an Anthropic document block (base64 PDF) -> IR document part.
  it("normalizes a base64 PDF document block into an IR document part", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
            },
          ],
        },
      ],
    };
    const ir = transformRequestOut(req);
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[1]).toMatchObject({
      type: "document",
      data: "JVBERi0=",
      mediaType: "application/pdf",
    });
  });

  it("normalizes a url document block into an IR document part", () => {
    const req = {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [{ type: "document", source: { type: "url", url: "https://x/doc.pdf" } }],
        },
      ],
    };
    const ir = transformRequestOut(req);
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({ type: "document", url: "https://x/doc.pdf" });
  });

  // Outbound: an IR document part -> Anthropic document block.
  it("renders an IR document part (base64) as an Anthropic document block", () => {
    const ir = IRRequestSchema.parse({
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            { type: "document", data: "JVBERi0=", mediaType: "application/pdf", filename: "r.pdf" },
          ],
        },
      ],
    });
    const native = transformRequestIn(ir);
    const block = native.messages[0]?.content?.[1] as {
      type?: string;
      source?: { type?: string; media_type?: string; data?: string; url?: string };
    };
    expect(block.type).toBe("document");
    expect(block.source?.type).toBe("base64");
    expect(block.source?.media_type).toBe("application/pdf");
    expect(block.source?.data).toBe("JVBERi0=");
  });

  it("renders an IR document part (remote url) as an Anthropic url document block", () => {
    const ir = IRRequestSchema.parse({
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [{ role: "user", content: [{ type: "document", url: "https://x/doc.pdf" }] }],
    });
    const native = transformRequestIn(ir);
    const block = native.messages[0]?.content?.[0] as {
      type?: string;
      source?: { type?: string; url?: string };
    };
    expect(block.type).toBe("document");
    expect(block.source?.type).toBe("url");
    expect(block.source?.url).toBe("https://x/doc.pdf");
  });

  // Regression (Codex P1): an uploaded-file source must round-trip as a {type:"file"}
  // source (file_id), NOT be collapsed to document.url and re-emitted as a url source.
  it("round-trips an uploaded file_id document source (not url-collapsed)", () => {
    const native = {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [{ type: "document", source: { type: "file", file_id: "file_xyz" } }],
        },
      ],
    };
    const ir = transformRequestOut(native) as IRRequest;
    const part = (ir.messages[0]?.content as Array<Record<string, unknown>>)[0];
    expect(part).toMatchObject({ type: "document", fileId: "file_xyz" });
    expect((part as { url?: string }).url).toBeUndefined();

    const back = transformRequestIn(IRRequestSchema.parse(ir));
    const block = back.messages[0]?.content?.[0] as {
      source?: { type?: string; file_id?: string; url?: string };
    };
    expect(block.source?.type).toBe("file");
    expect(block.source?.file_id).toBe("file_xyz");
    expect(block.source?.url).toBeUndefined();
  });

  // Regression (Codex P2): the degradation warnings must be OBSERVABLE — returned
  // alongside the native request, not silently dropped by transformRequestIn.
  it("transformRequestInWithWarnings surfaces n_capped + data_loss warnings", () => {
    const ir = IRRequestSchema.parse({
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      n: 4,
      logprobs: true,
    });
    const { request, warnings } = transformRequestInWithWarnings(ir);
    expect(JSON.stringify(request)).not.toContain("warnings"); // native wire stays clean
    const codes = warnings.map((w) => `${w.code}:${w.param}`);
    expect(codes).toContain("n_capped:n");
    expect(codes).toContain("data_loss:logprobs");
  });

  // P8 inter-translation hardening: non-mappable knobs degrade cleanly + are recorded.
  it("never leaks n / logprobs / modalities onto the Anthropic wire (reject-clean)", () => {
    const ir = IRRequestSchema.parse({
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      n: 3,
      logprobs: true,
      modalities: ["text", "audio"],
    });
    const native = transformRequestIn(ir);
    const serialized = JSON.stringify(native);
    // None of the unsupported OpenAI knobs reach Anthropic's wire shape.
    expect(serialized).not.toContain('"n"');
    expect(serialized).not.toContain("logprobs");
    expect(serialized).not.toContain("modalities");
    // ...and no internal bookkeeping (provider_raw / warnings) leaks either.
    expect(serialized).not.toContain("provider_raw");
    expect(serialized).not.toContain("warnings");
  });

  it("guardRequestFor('anthropic', ir) records the degradation observably on the IR", () => {
    const ir = IRRequestSchema.parse({
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
      n: 5,
      logprobs: true,
      modalities: ["text", "audio"],
    });
    const guarded = guardRequestFor("anthropic", ir);
    expect(guarded.n).toBe(1);
    const codes = readWarnings(guarded).map((w) => `${w.code}:${w.param}`);
    expect(codes).toContain("n_capped:n");
    expect(codes).toContain("data_loss:logprobs");
    expect(codes).toContain("data_loss:modalities");
  });
});
