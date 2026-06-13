import { describe, expect, it } from "vitest";
import {
  prependMemoryToAnthropicBody,
  prependMemoryToResponsesBody,
} from "./native-memory-inject.js";

// native-memory-inject (#217 Phase 4 PREFIX model) — the gateway-side splice that
// prepends the assembled memory text block into a NATIVE passthrough request's
// system-level field WITHOUT touching the live conversation (messages / input). The
// helpers are PURE (return a NEW body, never mutate the input) so the verbatim carrier
// the executor forwards stays byte-faithful except for the additive memory prefix.

const MEMORY = "# Persistent memory (injected by helm)\n## Project knowledge\nbe kind";

describe("prependMemoryToAnthropicBody", () => {
  it("prepends the block when system is a STRING (with blank-line separator)", () => {
    const body = {
      model: "claude-3-5-sonnet",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = prependMemoryToAnthropicBody(body, MEMORY);
    expect(out.system).toBe(`${MEMORY}\n\nbe terse`);
    // messages are kept VERBATIM (same reference, untouched).
    expect(out.messages).toBe(body.messages);
    // A NEW body is returned — the input is never mutated.
    expect(out).not.toBe(body);
    expect(body.system).toBe("be terse");
  });

  it("sets system to the block alone when system is ABSENT", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const out = prependMemoryToAnthropicBody(body, MEMORY);
    expect(out.system).toBe(MEMORY);
    expect(out.messages).toBe(body.messages);
  });

  it("sets system to the block alone when system is an EMPTY string", () => {
    const body = { model: "m", system: "", messages: [] };
    const out = prependMemoryToAnthropicBody(body, MEMORY);
    expect(out.system).toBe(MEMORY);
  });

  it("prepends a text block when system is an ARRAY of content blocks", () => {
    const body = {
      model: "m",
      system: [
        { type: "text", text: "be terse" },
        { type: "text", text: "cite sources" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = prependMemoryToAnthropicBody(body, MEMORY);
    expect(Array.isArray(out.system)).toBe(true);
    expect(out.system).toEqual([
      { type: "text", text: MEMORY },
      { type: "text", text: "be terse" },
      { type: "text", text: "cite sources" },
    ]);
    // The original array is not mutated.
    expect((body.system as unknown[]).length).toBe(2);
    expect(out.messages).toBe(body.messages);
  });

  it("preserves tool messages in the conversation VERBATIM (additive prefix only)", () => {
    const body = {
      model: "m",
      system: "be terse",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
        },
      ],
    };
    const out = prependMemoryToAnthropicBody(body, MEMORY);
    // The entire messages array is the SAME reference — tool_use/tool_result untouched.
    expect(out.messages).toBe(body.messages);
    expect(out.system).toBe(`${MEMORY}\n\nbe terse`);
  });
});

describe("prependMemoryToResponsesBody", () => {
  it("prepends the block to a STRING instructions (with blank-line separator)", () => {
    const body = {
      model: "gpt-5.5",
      instructions: "be terse",
      input: [{ role: "user", content: "hi" }],
    };
    const out = prependMemoryToResponsesBody(body, MEMORY);
    expect(out.instructions).toBe(`${MEMORY}\n\nbe terse`);
    expect(out.input).toBe(body.input);
    expect(out).not.toBe(body);
    expect(body.instructions).toBe("be terse");
  });

  it("sets instructions to the block alone (no trailing separator) when ABSENT", () => {
    const body = { model: "m", input: [{ role: "user", content: "hi" }] };
    const out = prependMemoryToResponsesBody(body, MEMORY);
    expect(out.instructions).toBe(MEMORY);
    expect(out.input).toBe(body.input);
  });

  it("sets instructions to the block alone when instructions is an EMPTY string", () => {
    const body = { model: "m", instructions: "", input: [] };
    const out = prependMemoryToResponsesBody(body, MEMORY);
    expect(out.instructions).toBe(MEMORY);
  });

  it("keeps input VERBATIM (additive prefix only)", () => {
    const body = {
      model: "m",
      input: [
        { role: "user", content: "hi" },
        { type: "function_call", call_id: "c1", name: "search", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    };
    const out = prependMemoryToResponsesBody(body, MEMORY);
    expect(out.input).toBe(body.input);
    expect(out.instructions).toBe(MEMORY);
  });
});
