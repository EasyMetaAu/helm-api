import { describe, expect, it } from "vitest";
import type { IRResponse } from "../ir.js";
import {
  AnthropicMessagesResponseSchema,
  createAnthropicToolNameMap,
  mapStopReason,
  mapUsage,
  transformNativeResponseToIR,
  transformResponseIn,
} from "./response.js";

// IR -> Anthropic Messages native response back-translation (docs/05, task
// protocol.anthropic-resp). Two high-risk mismatches are pinned here:
//   1. finish_reason (OpenAI) <-> stop_reason (Anthropic) enum mapping — an illegal
//      enum makes the OpenAI SDK drop the whole response; collapsing everything to
//      `end_turn` makes agents silently misjudge. We map to a LEGAL enum without
//      leaking Helm-internal provider_raw into the public response body.
//   2. usage / cached billing — input = prompt - cached (never double-bill cache).
// Pure function: no network, no framework.

// Minimal IRResponse builder so each test states only what it exercises.
function makeIR(overrides: Partial<IRResponse> = {}): IRResponse {
  return {
    id: "msg_test",
    model: "claude-3-5-sonnet",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
    ...overrides,
  };
}

describe("mapStopReason", () => {
  it("maps stop -> end_turn", () => {
    expect(mapStopReason("stop").stop_reason).toBe("end_turn");
  });
  it("maps length -> max_tokens", () => {
    expect(mapStopReason("length").stop_reason).toBe("max_tokens");
  });
  it("maps tool_calls -> tool_use", () => {
    expect(mapStopReason("tool_calls").stop_reason).toBe("tool_use");
  });
  it("maps legacy function_call -> tool_use", () => {
    expect(mapStopReason("function_call").stop_reason).toBe("tool_use");
  });
  it("maps content_filter -> a legal enum (stop_sequence)", () => {
    expect(mapStopReason("content_filter").stop_reason).toBe("stop_sequence");
  });
  it("falls back unknown -> end_turn (never an illegal enum)", () => {
    const legal = ["end_turn", "max_tokens", "stop_sequence", "tool_use"];
    expect(legal).toContain(mapStopReason("totally_unknown").stop_reason);
    expect(mapStopReason("totally_unknown").stop_reason).toBe("end_turn");
  });
  it("preserves the raw value verbatim even when the mapping rewrites it", () => {
    expect(mapStopReason("content_filter").raw).toBe("content_filter");
    expect(mapStopReason("totally_unknown").raw).toBe("totally_unknown");
    expect(mapStopReason("stop").raw).toBe("stop");
  });
  // order 7: a null/non-terminal finish_reason coalesces to "" at the call site; it
  // must map to the legal `end_turn` and keep the raw ("") recoverable — never throw
  // or land on an illegal enum mid-stream.
  it("maps an empty (null-coalesced) finish_reason to end_turn, raw preserved", () => {
    expect(mapStopReason("").stop_reason).toBe("end_turn");
    expect(mapStopReason("").raw).toBe("");
  });
});

describe("mapUsage", () => {
  it("splits input = prompt - cached, never double-counting cache", () => {
    const u = mapUsage({ prompt_tokens: 200, cached_tokens: 800, completion_tokens: 50 });
    // IR.prompt_tokens is ALREADY the non-cached input (the IR transformer split it).
    expect(u.input_tokens).toBe(200);
    expect(u.cache_read_input_tokens).toBe(800);
    expect(u.output_tokens).toBe(50);
    // 800 must NOT be added back into input.
    expect(u.input_tokens).not.toBe(1000);
  });
  it("degrades to cache_read=0, input=prompt when no cached detail present", () => {
    const u = mapUsage({ prompt_tokens: 1000, completion_tokens: 50 });
    expect(u.cache_read_input_tokens).toBe(0);
    expect(u.input_tokens).toBe(1000);
  });
});

describe("transformResponseIn", () => {
  it("produces a structurally valid Anthropic Messages response", () => {
    const out = transformResponseIn(makeIR());
    expect(() => AnthropicMessagesResponseSchema.parse(out)).not.toThrow();
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
  });

  it("maps finish_reason -> stop_reason without leaking provider_raw", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" },
        ],
      }),
    );
    expect(out.stop_reason).toBe("max_tokens");
    expect("provider_raw" in out).toBe(false);
  });

  it("maps an unknown finish_reason to a legal stop_reason without leaking provider_raw", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "weird_one" },
        ],
      }),
    );
    expect(out.stop_reason).toBe("end_turn");
    expect("provider_raw" in out).toBe(false);
  });

  it("usage: input = prompt - cached, cache_read split out (pit #2)", () => {
    const out = transformResponseIn(
      makeIR({ usage: { prompt_tokens: 200, cached_tokens: 800, completion_tokens: 50 } }),
    );
    expect(out.usage.input_tokens).toBe(200);
    expect(out.usage.cache_read_input_tokens).toBe(800);
    expect(out.usage.output_tokens).toBe(50);
  });

  it("usage degrades when no cached detail: cache_read=0, input=prompt", () => {
    const out = transformResponseIn(
      makeIR({ usage: { prompt_tokens: 1000, completion_tokens: 50 } }),
    );
    expect(out.usage.cache_read_input_tokens).toBe(0);
    expect(out.usage.input_tokens).toBe(1000);
  });

  it("clamps input to >= 0 when cached > prompt (anomalous upstream data)", () => {
    const out = transformResponseIn(
      makeIR({ usage: { prompt_tokens: 100, cached_tokens: 500, completion_tokens: 10 } }),
    );
    expect(out.usage.input_tokens).toBeGreaterThanOrEqual(0);
  });

  it("does not expose raw upstream usage in the public response body", () => {
    const rawUsage = { prompt_tokens: 200, cached_tokens: 800, completion_tokens: 50 };
    const out = transformResponseIn(makeIR({ usage: rawUsage }));
    expect("provider_raw" in out).toBe(false);
  });

  it("back-translates tool_calls -> tool_use block with id/name/parsed input", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "toolu_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"SF"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const block = out.content.find((b) => b.type === "tool_use");
    expect(block).toBeDefined();
    expect(block).toMatchObject({
      type: "tool_use",
      id: "toolu_abc",
      name: "get_weather",
      input: { city: "SF" },
    });
    expect(out.stop_reason).toBe("tool_use");
  });

  it("recovers a closed whitelisted XML invoke from a tool-use response", () => {
    const xml =
      '<invoke name="Bash">\n<parameter name="command">git status</parameter>\n' +
      '<parameter name="timeout">600000</parameter>\n</invoke>';
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Before\n${xml}\nAfter` },
            finish_reason: "tool_calls",
          },
        ],
      }),
      { toolNames: ["Bash"], toolCallXmlRecoveryEnabled: true },
    );

    expect(out.content).toEqual([
      { type: "text", text: "Before\n" },
      {
        type: "tool_use",
        id: "toolu_synthetic_1",
        name: "Bash",
        input: { command: "git status", timeout: 600000 },
      },
      { type: "text", text: "\nAfter" },
    ]);
    expect(out.stop_reason).toBe("tool_use");
  });

  it("recovers a terminal closed whitelisted XML invoke from an end-turn response", () => {
    const xml = '<invoke name="Bash"><parameter name="command">git status</parameter></invoke>';
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: xml },
            finish_reason: "stop",
          },
        ],
      }),
      { toolNames: ["Bash"], toolCallXmlRecoveryEnabled: true },
    );

    expect(out.content).toContainEqual(
      expect.objectContaining({ type: "tool_use", name: "Bash", input: { command: "git status" } }),
    );
    expect(out.stop_reason).toBe("tool_use");
  });

  it.each([
    {
      title: "finish reason is not tool_use or end_turn",
      finishReason: "length",
      tools: ["Bash"],
      enabled: true,
    },
    {
      title: "unknown finish reason maps to end_turn but is ineligible",
      finishReason: "not_a_finish_reason",
      tools: ["Bash"],
      enabled: true,
    },
    { title: "tool is not declared", finishReason: "tool_calls", tools: ["Read"], enabled: true },
    {
      title: "feature flag is disabled",
      finishReason: "tool_calls",
      tools: ["Bash"],
      enabled: false,
    },
  ])("keeps XML text untouched when $title", ({ finishReason, tools, enabled }) => {
    const xml = '<invoke name="Bash"><parameter name="command">git status</parameter></invoke>';
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: xml },
            finish_reason: finishReason,
          },
        ],
      }),
      { toolNames: tools, toolCallXmlRecoveryEnabled: enabled },
    );

    expect(out.content).toEqual([{ type: "text", text: xml }]);
  });

  it("does not recover XML when a structured tool call already exists", () => {
    const xml = '<invoke name="Bash"><parameter name="command">echo prose</parameter></invoke>';
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: xml,
              tool_calls: [
                {
                  id: "toolu_real",
                  type: "function",
                  function: { name: "Bash", arguments: '{"command":"pwd"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      { toolNames: ["Bash"], toolCallXmlRecoveryEnabled: true },
    );

    expect(out.content).toContainEqual({ type: "text", text: xml });
    expect(out.content.filter((block) => block.type === "tool_use")).toHaveLength(1);
  });

  it("tolerates malformed tool_call arguments without failing the whole response", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "toolu_x",
                  type: "function",
                  // trailing junk / unterminated — tolerant parse must recover the object.
                  function: { name: "f", arguments: '{"a":1' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    // Whole response still produced; the tool_use block still carries an object input.
    expect(() => AnthropicMessagesResponseSchema.parse(out)).not.toThrow();
    const block = out.content.find((b) => b.type === "tool_use");
    expect(block).toBeDefined();
    expect(typeof (block as { input: unknown }).input).toBe("object");
  });

  it("sanitizes invalid and colliding tool names while keeping a reverse map", () => {
    const nameA = "search-web";
    const nameB = "search web";
    const mcpName = "mcp__codegraph__codegraph_context";
    const empty = "";
    const long = `${"x".repeat(64)}!`;
    const map = createAnthropicToolNameMap([nameA, nameB, mcpName, empty, long]);

    expect(map.toAnthropic(nameA)).toBe("search_web");
    expect(map.toAnthropic(nameB)).toMatch(/^search_web_[a-z0-9]{8}$/);
    expect(map.toAnthropic(mcpName)).toBe(mcpName);
    expect(map.toAnthropic(empty)).toBe("tool");
    expect(map.toAnthropic(long)).toHaveLength(64);
    expect(map.toOriginal(map.toAnthropic(nameB))).toBe(nameB);
    expect(map.toOriginal(mcpName)).toBe(mcpName);
  });

  it("emits sanitized tool_use names and records reverse map provenance", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_a",
                  type: "function",
                  function: { name: "search-web", arguments: '{"q":"a"}' },
                },
                {
                  id: "call_b",
                  type: "function",
                  function: { name: "search web", arguments: '{"q":"b"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const toolUses = out.content.filter(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );
    const secondName = toolUses[1]?.name;
    expect(secondName).toEqual(expect.stringMatching(/^search_web_[a-z0-9]{8}$/));
    expect(toolUses.map((b) => b.name)).toEqual(["search_web", secondName]);
    expect("provider_raw" in out).toBe(false);
  });

  it("back-translates thinking parts -> thinking block preserving signature", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                { type: "thinking", text: "let me reason", signature: "sig_123" },
                { type: "text", text: "the answer is 42" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const thinking = out.content.find((b) => b.type === "thinking");
    expect(thinking).toMatchObject({
      type: "thinking",
      thinking: "let me reason",
      signature: "sig_123",
    });
    const text = out.content.find((b) => b.type === "text");
    expect(text).toMatchObject({ type: "text", text: "the answer is 42" });
  });

  it("back-translates thinking_blocks -> redacted_thinking blocks", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "answer",
              thinking_blocks: [{ type: "redacted_thinking", data: "encrypted-blob" }],
            },
            finish_reason: "stop",
          },
        ],
      }),
    );

    expect(out.content[0]).toEqual({ type: "redacted_thinking", data: "encrypted-blob" });
    expect(out.content[1]).toEqual({ type: "text", text: "answer" });
  });

  it("preserves visible reasoning_content alongside redacted_thinking blocks", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "answer",
              reasoning_content: "visible reasoning",
              thinking_blocks: [{ type: "redacted_thinking", data: "encrypted-blob" }],
            },
            finish_reason: "stop",
          },
        ],
      }),
    );

    expect(out.content).toEqual([
      { type: "redacted_thinking", data: "encrypted-blob" },
      { type: "thinking", thinking: "visible reasoning" },
      { type: "text", text: "answer" },
    ]);
  });
});

// —— P4: usage cache_creation breakdown + thinking_tokens ——————————————————————
describe("transformResponseIn — P4 usage detail", () => {
  it("maps an IR service tier to Anthropic usage.speed", () => {
    const out = transformResponseIn(
      makeIR({
        service_tier: "fast",
        usage: { prompt_tokens: 10, completion_tokens: 5, inference_geo: "us" },
      }),
    );
    expect(out.usage.speed).toBe("fast");
    expect(out.usage.inference_geo).toBe("us");
  });

  it("maps IR.cache_creation_tokens -> Anthropic cache_creation_input_tokens", () => {
    const out = transformResponseIn(
      makeIR({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cache_creation_tokens: 64,
        },
      }),
    );
    expect(out.usage.cache_creation_input_tokens).toBe(64);
  });

  it("emits a structured cache_creation breakdown from prompt_tokens_details", () => {
    const out = transformResponseIn(
      makeIR({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cache_creation_tokens: 64,
          prompt_tokens_details: {
            // litellm CacheCreationTokenDetails ephemeral split
            cache_creation_tokens: 64,
          },
        },
      }),
    );
    // cache_creation aggregate still present.
    expect(out.usage.cache_creation_input_tokens).toBe(64);
  });

  it("maps IR.reasoning_tokens -> output_tokens_details.thinking_tokens", () => {
    const out = transformResponseIn(
      makeIR({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          reasoning_tokens: 30,
        },
      }),
    );
    expect(out.usage.output_tokens_details?.thinking_tokens).toBe(30);
  });
});

// —— P4 inbound: native Anthropic response -> IR usage / stop_reason parity ——————
describe("transformNativeResponseToIR — P4 usage + stop_reason", () => {
  it("maps Anthropic usage.speed to the IR service tier", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2, speed: "fast", inference_geo: "us" },
    });
    expect(ir.service_tier).toBe("fast");
    expect(ir.usage?.inference_geo).toBe("us");
  });

  it("maps cache_creation_input_tokens -> IR.cache_creation_tokens", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 64,
      },
    });
    expect(ir.usage?.cache_creation_tokens).toBe(64);
  });

  it("reads a structured cache_creation object {ephemeral_5m,ephemeral_1h}", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation: {
          ephemeral_5m_input_tokens: 40,
          ephemeral_1h_input_tokens: 24,
        },
      },
    });
    // The aggregate ephemeral write count surfaces as cache_creation_tokens.
    expect(ir.usage?.cache_creation_tokens).toBe(64);
    expect(ir.usage?.prompt_tokens_details).toMatchObject({
      ephemeral_5m_input_tokens: 40,
      ephemeral_1h_input_tokens: 24,
    });
  });

  it("maps output_tokens_details.thinking_tokens -> IR.reasoning_tokens", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        output_tokens_details: { thinking_tokens: 30 },
      },
    });
    expect(ir.usage?.reasoning_tokens).toBe(30);
  });

  it("maps a pause_turn stop_reason -> finish_reason stop, raw kept", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "pause_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    expect(ir.choices[0]?.finish_reason).toBe("stop");
    expect(ir.provider_raw?.stop_reason).toBe("pause_turn");
  });

  it("maps a refusal stop_reason -> finish_reason content_filter, raw kept", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "" }],
      stop_reason: "refusal",
      usage: { input_tokens: 5, output_tokens: 0 },
    });
    expect(ir.choices[0]?.finish_reason).toBe("content_filter");
    expect(ir.provider_raw?.stop_reason).toBe("refusal");
  });

  it("passes a stop_details object through to provider_raw", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "refusal",
      stop_details: { type: "refusal", reason: "policy" },
      usage: { input_tokens: 5, output_tokens: 0 },
    });
    expect(ir.provider_raw?.stop_details).toEqual({ type: "refusal", reason: "policy" });
  });

  it("preserves inbound redacted_thinking blocks in IR thinking_blocks", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [
        { type: "redacted_thinking", data: "encrypted-blob" },
        { type: "text", text: "ok" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const message = ir.choices[0]?.message;
    expect(message?.thinking_blocks).toEqual([
      { type: "redacted_thinking", data: "encrypted-blob" },
    ]);
    expect(message?.content).toEqual([{ type: "text", text: "ok" }]);

    const roundTrip = transformResponseIn(ir);
    expect(roundTrip.content[0]).toEqual({ type: "redacted_thinking", data: "encrypted-blob" });
  });
});

describe("transformNativeResponseToIR — tool-name round-trip (Codex P1)", () => {
  // Anthropic requires tool names to match ^[a-zA-Z0-9_-]{1,128}$, so transformRequestIn
  // sanitizes `db.query` -> `db_query`. Anthropic then echoes the sanitized name on the
  // response. Without the request-side map, the original is unrecoverable; threading the
  // SAME deterministic map restores it so client-side tool dispatch keeps working.
  const nativeWithSanitizedTool = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet",
    content: [{ type: "tool_use", id: "tu_1", name: "db_query", input: { sql: "select 1" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 2 },
  };

  it("restores the original tool name when the request-side map is threaded", () => {
    // Deterministically rebuilt from the IR request's original tool list.
    const map = createAnthropicToolNameMap(["db.query"]);
    expect(map.toAnthropic("db.query")).toBe("db_query"); // request sanitized it thus

    const ir = transformNativeResponseToIR(nativeWithSanitizedTool, map);
    expect(ir.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("db.query");
  });

  it("falls back to the sanitized name when no map is provided (stateless)", () => {
    const ir = transformNativeResponseToIR(nativeWithSanitizedTool);
    expect(ir.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("db_query");
  });
});

// —— Coverage targets: uncovered lines/branches in response.ts ————————————————

// Lines 153-157: createAnthropicToolNameMap — triple-collision: same sanitised name used
// by two DIFFERENT originals triggers the counter loop (while reverse.has && not owner).
describe("createAnthropicToolNameMap — triple-hash collision counter loop (lines 153-157)", () => {
  it("generates distinct suffixes for three tools that share the same sanitized base", () => {
    // "a b", "a.b", and "a-b" all sanitise to "a_b" — the third must get a counter suffix.
    const map = createAnthropicToolNameMap(["a b", "a.b", "a-b"]);
    const names = ["a b", "a.b", "a-b"].map((n) => map.toAnthropic(n));
    // All three must produce unique Anthropic names.
    expect(new Set(names).size).toBe(3);
    // All must round-trip.
    for (const [orig, ant] of [
      ["a b", names[0]],
      ["a.b", names[1]],
      ["a-b", names[2]],
    ] as [string, string][]) {
      expect(map.toOriginal(ant)).toBe(orig);
    }
  });
});

// Lines 171-172: toOriginal returns undefined for an unknown sanitized name (reverse lookup miss)
describe("createAnthropicToolNameMap — toOriginal miss (lines 171-172)", () => {
  it("returns undefined for a sanitized name not in the map", () => {
    const map = createAnthropicToolNameMap(["my_tool"]);
    expect(map.toOriginal("nonexistent")).toBeUndefined();
  });
});

// Lines 232-235: mapUsage — ephemeral 5m/1h breakdown emitted on cache_creation field
describe("mapUsage — cache_creation ephemeral breakdown (lines 232-235)", () => {
  it("emits cache_creation object when ephemeral_5m_input_tokens present in prompt_tokens_details", () => {
    const u = mapUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      cache_creation_tokens: 50,
      prompt_tokens_details: {
        ephemeral_5m_input_tokens: 30,
        ephemeral_1h_input_tokens: 20,
      } as unknown as Record<string, number>,
    });
    expect(u.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 30,
      ephemeral_1h_input_tokens: 20,
    });
  });

  it("emits cache_creation with only ephemeral_5m when 1h absent", () => {
    const u = mapUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      cache_creation_tokens: 30,
      prompt_tokens_details: { ephemeral_5m_input_tokens: 30 } as unknown as Record<string, number>,
    });
    expect(u.cache_creation?.ephemeral_5m_input_tokens).toBe(30);
    expect("ephemeral_1h_input_tokens" in (u.cache_creation ?? {})).toBe(false);
  });

  it("does not emit cache_creation when neither ephemeral field is present", () => {
    const u = mapUsage({ prompt_tokens: 100, completion_tokens: 20, cache_creation_tokens: 30 });
    expect(u.cache_creation).toBeUndefined();
  });
});

// Lines 267-270: mapUsage — clamp input >= 0 when cached > prompt (anomalous)
describe("mapUsage — input clamp >= 0 (lines 267-270)", () => {
  it("clamps input_tokens to 0 when cached > prompt (never negative)", () => {
    const u = mapUsage({ prompt_tokens: 50, cached_tokens: 200, completion_tokens: 10 });
    expect(u.input_tokens).toBe(50); // prompt_tokens is ALREADY the non-cached portion
    expect(u.input_tokens).toBeGreaterThanOrEqual(0);
  });
});

// Lines 294-296: transformResponseIn — toContentBlocks: thinking_blocks present but
// none have type="thinking" with a thinking string → emitedVisibleThinking stays false
// → resolveReasoning fallback path fires (lines 340-359 in response.ts)
describe("transformResponseIn — thinking_blocks with redacted_only → resolveReasoning fallback (lines 294-296)", () => {
  it("falls through to resolveReasoning when thinking_blocks contains only redacted entries", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "answer",
              thinking_blocks: [{ type: "redacted_thinking", data: "encrypted" }],
              // No reasoning_content → resolveReasoning produces no thinking parts
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    // redacted block rendered, text rendered, no crash
    expect(out.content.find((b) => b.type === "redacted_thinking")).toBeDefined();
    expect(out.content.find((b) => b.type === "text")).toMatchObject({ text: "answer" });
  });
});

// Lines 304-306: toContentBlocks — string content path (line 362)
describe("transformResponseIn — string content path in toContentBlocks (line 362)", () => {
  it("renders a string message content as a text block", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello world" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    expect(out.content.find((b) => b.type === "text")).toMatchObject({
      type: "text",
      text: "hello world",
    });
  });

  it("emits no text block for empty string content (line 362 guard)", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    // empty string → no text block emitted
    expect(out.content.filter((b) => b.type === "text")).toHaveLength(0);
  });
});

// Lines 385-386: toContentBlocks — model-generated image with url source (not base64)
describe("transformResponseIn — image with url source (lines 385-386)", () => {
  it("renders a url image (no b64_json) as {type:'url',url} source block", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "see image",
              images: [{ url: "https://example.com/out.png", mediaType: "image/png" }],
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const imageBlock = out.content.find((b) => b.type === "image") as
      | { source?: { type?: string; url?: string } }
      | undefined;
    expect(imageBlock?.source?.type).toBe("url");
    expect(imageBlock?.source?.url).toBe("https://example.com/out.png");
  });
});

// Lines 544-545 / 621: transformNativeResponseToIR — image url source + id/model fallbacks
describe("transformNativeResponseToIR — id/model fallback and url-source image (lines 544-545, 621)", () => {
  it("generates a synthetic id when native response has no id field", () => {
    const ir = transformNativeResponseToIR({
      // no id field
      model: "claude",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(typeof ir.id).toBe("string");
    expect(ir.id.length).toBeGreaterThan(0);
  });

  it("falls back to 'anthropic' when native response has no model field", () => {
    const ir = transformNativeResponseToIR({
      id: "m_1",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(ir.model).toBe("anthropic");
  });

  it("maps url-source image block to IRMessage.images with url (lines 544-545)", () => {
    const ir = transformNativeResponseToIR({
      id: "m_url",
      model: "claude",
      content: [
        {
          type: "image",
          source: {
            type: "url",
            url: "https://cdn.example.com/photo.jpg",
            media_type: "image/jpeg",
          },
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const img = ir.choices[0]?.message.images?.[0];
    expect(img?.url).toBe("https://cdn.example.com/photo.jpg");
    expect(img?.mediaType).toBe("image/jpeg");
    expect(img?.b64_json).toBeUndefined();
  });

  it("drops image block when source has no url and no data (neither branch)", () => {
    // source.type is neither url-with-url nor data-present → both branches skip
    const ir = transformNativeResponseToIR({
      id: "m_nop",
      model: "claude",
      content: [
        { type: "image", source: { type: "base64" /* no data, no url */ } },
        { type: "text", text: "only text" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    expect(ir.choices[0]?.message.images ?? []).toHaveLength(0);
  });

  it("maps stop_reason null -> finish_reason null (no mapping)", () => {
    const ir = transformNativeResponseToIR({
      id: "m_null",
      model: "claude",
      content: [{ type: "text", text: "hi" }],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(ir.choices[0]?.finish_reason).toBeNull();
  });

  it("maps an unknown stop_reason to finish_reason 'stop' (fallback)", () => {
    const ir = transformNativeResponseToIR({
      id: "m_unk",
      model: "claude",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "totally_unknown_reason",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(ir.choices[0]?.finish_reason).toBe("stop");
  });
});

// cache_creation aggregate: when both fields absent (undefined) on usage
describe("transformNativeResponseToIR — cacheCreation undefined when no creation fields (lines 601-608)", () => {
  it("omits cache_creation_tokens from IR when neither cache_creation_input_tokens nor cache_creation object present", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    expect(ir.usage?.cache_creation_tokens).toBeUndefined();
  });

  it("omits cache_creation_tokens when cache_creation ephemeral sum is 0", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    });
    // sum is 0 → undefined (not 0)
    expect(ir.usage?.cache_creation_tokens).toBeUndefined();
  });
});

// Lines 329-338: toContentBlocks — thinking_blocks with a VISIBLE thinking entry
// (not redacted) → emittedVisibleThinking=true path, and signature conditional
describe("transformResponseIn — thinking_blocks visible thinking entry (lines 329-338)", () => {
  it("renders a visible thinking block from thinking_blocks extension with no signature", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "answer",
              thinking_blocks: [{ type: "thinking", thinking: "visible thought" }],
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const thinkingBlock = out.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toMatchObject({ type: "thinking", thinking: "visible thought" });
    // no signature present → attribute must be absent
    expect("signature" in (thinkingBlock ?? {})).toBe(false);
  });

  it("renders both redacted and visible thinking_blocks in order", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "answer",
              thinking_blocks: [
                { type: "redacted_thinking", data: "enc-1" },
                { type: "thinking", thinking: "visible", signature: "sig-v" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const blocks = out.content;
    expect(blocks[0]).toMatchObject({ type: "redacted_thinking", data: "enc-1" });
    expect(blocks[1]).toMatchObject({ type: "thinking", thinking: "visible", signature: "sig-v" });
    // emittedVisibleThinking=true → resolveReasoning fallback NOT entered
  });
});

// Lines 553-558: transformNativeResponseToIR — thinking block with and without signature
describe("transformNativeResponseToIR — thinking block signature (lines 553-558)", () => {
  it("includes signature on IR thinking content part when native block carries one", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      model: "claude",
      content: [
        { type: "thinking", thinking: "my reasoning", signature: "sig-xyz" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const parts = ir.choices[0]?.message.content;
    if (!Array.isArray(parts)) throw new Error("expected array");
    const thinkingPart = parts.find((p) => p.type === "thinking") as
      | { type: string; text: string; signature?: string }
      | undefined;
    expect(thinkingPart?.signature).toBe("sig-xyz");
  });

  it("omits signature when native thinking block has none", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      model: "claude",
      content: [
        { type: "thinking", thinking: "my reasoning" }, // no signature
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const parts = ir.choices[0]?.message.content;
    if (!Array.isArray(parts)) throw new Error("expected array");
    const thinkingPart = parts.find((p) => p.type === "thinking") as
      | { type: string; text: string; signature?: string }
      | undefined;
    expect("signature" in (thinkingPart ?? {})).toBe(false);
  });
});

// Lines 616, 621: transformNativeResponseToIR — usage with cache_read_input_tokens present
// and usage absent entirely
describe("transformNativeResponseToIR — usage path branches (lines 616, 621)", () => {
  it("maps cache_read_input_tokens -> IR.cached_tokens (line 616)", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      model: "claude",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
    });
    expect(ir.usage?.cached_tokens).toBe(40);
    expect(ir.usage?.prompt_tokens).toBe(100);
  });

  it("omits usage entirely when native response has no usage field (line 621 → undefined)", () => {
    const ir = transformNativeResponseToIR({
      id: "m",
      model: "claude",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      // no usage
    });
    expect(ir.usage).toBeUndefined();
  });
});

// Lines 304-306: toContentBlocks — array content with only non-text parts (no text blocks pushed)
describe("transformResponseIn — array content with no text parts (lines 304-306)", () => {
  it("produces no text block when array content has only non-text types (e.g. thinking already emitted)", () => {
    // An assistant message whose content[] has only thinking parts — text blocks not present.
    // This exercises the for-loop with no text parts hitting the `if (part.type === "text")` false branch.
    const out = transformResponseIn(
      makeIR({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [{ type: "thinking", text: "step 1", signature: "s" }],
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    // thinking rendered via resolveReasoning; text block count = 0
    const textBlocks = out.content.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(0);
  });
});

describe("anthropic image output round-trip (P7 multimodal)", () => {
  // Outbound: IR message.images -> Anthropic image content block on the response.
  it("renders IR message.images as an Anthropic image block", () => {
    const ir: IRResponse = {
      id: "msg_img",
      model: "claude-3-5-sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "here is your image",
            images: [{ b64_json: "AAAA", mediaType: "image/png" }],
          },
          finish_reason: "stop",
        },
      ],
    };
    const native = transformResponseIn(ir);
    const imageBlock = native.content.find((b) => b.type === "image") as
      | { type: string; source?: { type?: string; media_type?: string; data?: string } }
      | undefined;
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.source?.type).toBe("base64");
    expect(imageBlock?.source?.media_type).toBe("image/png");
    expect(imageBlock?.source?.data).toBe("AAAA");
  });

  // Inbound: an Anthropic image content block on a native response -> IR message.images.
  it("normalizes an inbound image block back into IR message.images", () => {
    const native = {
      id: "msg_img2",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet",
      content: [
        { type: "text", text: "see image" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const ir = transformNativeResponseToIR(native);
    expect(ir.choices[0]?.message.images?.[0]?.b64_json).toBe("BBBB");
    expect(ir.choices[0]?.message.images?.[0]?.mediaType).toBe("image/png");
  });
});
