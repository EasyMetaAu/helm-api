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
//      `end_turn` makes agents silently misjudge. We map to a LEGAL enum AND stash
//      the raw value in provider_raw.stop_reason.
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

  it("maps finish_reason -> stop_reason AND stashes the raw value in provider_raw", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" },
        ],
      }),
    );
    expect(out.stop_reason).toBe("max_tokens");
    expect(out.provider_raw?.stop_reason).toBe("length");
  });

  it("stashes the raw stop_reason even for an unknown finish_reason", () => {
    const out = transformResponseIn(
      makeIR({
        choices: [
          { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "weird_one" },
        ],
      }),
    );
    expect(out.stop_reason).toBe("end_turn");
    expect(out.provider_raw?.stop_reason).toBe("weird_one");
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

  it("preserves the raw upstream usage verbatim in provider_raw.usage", () => {
    const rawUsage = { prompt_tokens: 200, cached_tokens: 800, completion_tokens: 50 };
    const out = transformResponseIn(makeIR({ usage: rawUsage }));
    expect(out.provider_raw?.usage).toEqual(rawUsage);
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
    const empty = "";
    const long = `${"x".repeat(64)}!`;
    const map = createAnthropicToolNameMap([nameA, nameB, empty, long]);

    expect(map.toAnthropic(nameA)).toBe("search_web");
    expect(map.toAnthropic(nameB)).toMatch(/^search_web_[a-z0-9]{8}$/);
    expect(map.toAnthropic(empty)).toBe("tool");
    expect(map.toAnthropic(long)).toHaveLength(64);
    expect(map.toOriginal(map.toAnthropic(nameB))).toBe(nameB);
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
    expect(out.provider_raw?.anthropic_tool_name_map).toEqual({
      search_web: "search-web",
      [secondName as string]: "search web",
    });
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
