import { wrapMemoryReminder } from "@helm/core";
import { describe, expect, it } from "vitest";
import {
  appendMemoryToAnthropicBody,
  appendMemoryToResponsesBody,
} from "./native-memory-inject.js";

// native-memory-inject (#217 Phase 4 TRAILING-REMINDER model) — the gateway-side splice
// that APPENDS the assembled memory text block as ONE trailing `<system-reminder>` turn
// at the END of a NATIVE passthrough request's conversation, leaving `system` /
// `instructions` (and the whole client-cached prefix tools → system → history) BYTE-
// IDENTICAL. The helpers are PURE (return a NEW body, never mutate the input) so the
// verbatim carrier the executor forwards stays byte-faithful except for the one additive
// trailing turn — which sits AFTER the cached prefix, so the upstream prompt cache holds.

const MEMORY = "# Persistent memory (injected by helm)\n## Project knowledge\nbe kind";
const REMINDER = wrapMemoryReminder(MEMORY);

describe("appendMemoryToAnthropicBody", () => {
  it("appends a trailing <system-reminder> user turn and keeps `system` (string) VERBATIM", () => {
    const body = {
      model: "claude-3-5-sonnet",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = appendMemoryToAnthropicBody(body, MEMORY);
    // `system` is untouched — the client's cached system prefix survives.
    expect(out.system).toBe("be terse");
    // Memory rides ONE trailing user turn AFTER the conversation.
    expect(out.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: REMINDER },
    ]);
    // The existing turns are kept by reference, in order.
    expect((out.messages as unknown[])[0]).toBe(body.messages[0]);
    // A NEW body + NEW messages array — the input is never mutated.
    expect(out).not.toBe(body);
    expect(out.messages).not.toBe(body.messages);
    expect(body.messages).toHaveLength(1);
  });

  it("keeps `system` ARRAY by reference (byte-identical) and appends the reminder turn", () => {
    const body = {
      model: "m",
      system: [
        { type: "text", text: "be terse" },
        { type: "text", text: "cite sources", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = appendMemoryToAnthropicBody(body, MEMORY);
    // The cached system block array is forwarded UNCHANGED (same reference) — its
    // cache_control breakpoint is preserved.
    expect(out.system).toBe(body.system);
    expect(out.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: REMINDER },
    ]);
  });

  it("appends the reminder even when `system` is ABSENT (no system is synthesized)", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const out = appendMemoryToAnthropicBody(body, MEMORY);
    expect(out.system).toBeUndefined();
    expect(out.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: REMINDER },
    ]);
  });

  it("preserves tool messages in the conversation VERBATIM (additive trailing turn only)", () => {
    const toolCall = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
    };
    const toolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
    };
    const body = {
      model: "m",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }, toolCall, toolResult],
    };
    const out = appendMemoryToAnthropicBody(body, MEMORY);
    const msgs = out.messages as unknown[];
    // Every original turn survives by reference, in order; reminder is appended last.
    expect(msgs[0]).toBe(body.messages[0]);
    expect(msgs[1]).toBe(toolCall);
    expect(msgs[2]).toBe(toolResult);
    expect(msgs[3]).toEqual({ role: "user", content: REMINDER });
    expect(out.system).toBe("be terse");
  });

  it("sets messages to the lone reminder turn when `messages` is absent (defensive)", () => {
    const body = { model: "m", system: "be terse" };
    const out = appendMemoryToAnthropicBody(body, MEMORY);
    expect(out.messages).toEqual([{ role: "user", content: REMINDER }]);
    expect(out.system).toBe("be terse");
  });
});

describe("appendMemoryToResponsesBody", () => {
  it("keeps `instructions` (string) VERBATIM and appends a trailing reminder input item", () => {
    const body = {
      model: "gpt-5.5",
      instructions: "be terse",
      input: [{ role: "user", content: "hi" }],
    };
    const out = appendMemoryToResponsesBody(body, MEMORY);
    // `instructions` (the Responses system-equivalent) is untouched.
    expect(out.instructions).toBe("be terse");
    expect(out.input).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: REMINDER },
    ]);
    expect((out.input as unknown[])[0]).toBe(body.input[0]);
    expect(out).not.toBe(body);
    expect(out.input).not.toBe(body.input);
  });

  it("appends the reminder item even when `instructions` is ABSENT (none synthesized)", () => {
    const body = { model: "m", input: [{ role: "user", content: "hi" }] };
    const out = appendMemoryToResponsesBody(body, MEMORY);
    expect(out.instructions).toBeUndefined();
    expect(out.input).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: REMINDER },
    ]);
  });

  it("appends as trailing text when `input` is a STRING (prefix preserved)", () => {
    const body = { model: "m", instructions: "be terse", input: "hello there" };
    const out = appendMemoryToResponsesBody(body, MEMORY);
    expect(out.instructions).toBe("be terse");
    expect(out.input).toBe(`hello there\n\n${REMINDER}`);
  });

  it("sets input to the lone reminder when `input` is absent / empty", () => {
    expect(appendMemoryToResponsesBody({ model: "m" }, MEMORY).input).toBe(REMINDER);
    expect(appendMemoryToResponsesBody({ model: "m", input: "" }, MEMORY).input).toBe(REMINDER);
    expect(appendMemoryToResponsesBody({ model: "m", input: [] }, MEMORY).input).toEqual([
      { role: "user", content: REMINDER },
    ]);
  });

  it("keeps function-call input items VERBATIM (additive trailing item only)", () => {
    const fnCall = { type: "function_call", call_id: "c1", name: "search", arguments: "{}" };
    const fnOut = { type: "function_call_output", call_id: "c1", output: "done" };
    const body = {
      model: "m",
      input: [{ role: "user", content: "hi" }, fnCall, fnOut],
    };
    const out = appendMemoryToResponsesBody(body, MEMORY);
    const input = out.input as unknown[];
    expect(input[1]).toBe(fnCall);
    expect(input[2]).toBe(fnOut);
    expect(input[3]).toEqual({ role: "user", content: REMINDER });
  });
});
