import { describe, expect, it } from "vitest";
import { isUserMessageRequest } from "./user-turn.js";

// Pure detector for the per-account user-message serial queue (issue #93): only
// a request whose LAST message is a genuine user turn is serialized. Tool-result
// round-trips and assistant continuations must never queue. At the provider
// layer messages are OpenAI-shaped (tool results = role "tool"), but the content
// array is checked defensively for Anthropic-shaped tool_result blocks too.

describe("isUserMessageRequest", () => {
  it("true for a plain user string turn", () => {
    expect(isUserMessageRequest({ messages: [{ role: "user", content: "hi" }] })).toBe(true);
  });

  it("true when the last of several messages is a user turn", () => {
    expect(
      isUserMessageRequest({
        messages: [
          { role: "system", content: "be brief" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "next question" },
        ],
      }),
    ).toBe(true);
  });

  it("true for a user turn with a text-block content array", () => {
    expect(
      isUserMessageRequest({
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).toBe(true);
  });

  it("false when the last message is assistant / tool / system", () => {
    expect(
      isUserMessageRequest({ messages: [{ role: "assistant", content: "continuing…" }] }),
    ).toBe(false);
    expect(
      isUserMessageRequest({
        messages: [{ role: "tool", content: "result", tool_call_id: "t1" }],
      }),
    ).toBe(false);
    expect(isUserMessageRequest({ messages: [{ role: "system", content: "sys" }] })).toBe(false);
  });

  it("false for a user message carrying Anthropic-shaped tool_result blocks", () => {
    expect(
      isUserMessageRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42" }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isUserMessageRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "also some text" },
              { type: "tool_use_result", tool_use_id: "tu_2" },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it("false (fail-safe: never serialized) for empty / missing / malformed messages", () => {
    expect(isUserMessageRequest({ messages: [] })).toBe(false);
    expect(isUserMessageRequest({})).toBe(false);
    expect(isUserMessageRequest({ messages: "nope" })).toBe(false);
    expect(isUserMessageRequest({ messages: [null] })).toBe(false);
  });
});
