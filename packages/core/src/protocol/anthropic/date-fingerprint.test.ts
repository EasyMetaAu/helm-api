import { describe, expect, it } from "vitest";
import { normalizeClaudeCodeDateFingerprintInAnthropicRequest } from "./request.js";

describe("normalizeClaudeCodeDateFingerprintInAnthropicRequest", () => {
  it("restores Claude Code date apostrophe and slash variants in system content", () => {
    const input = {
      model: "claude-3-5-sonnet",
      system: [
        { type: "text", text: "Today’s date is 2026-07-01." },
        { type: "text", text: "Todayʼs date is 2026/07/02." },
        { type: "text", text: "Todayʹs date is 2026/07/03.", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };

    const out = normalizeClaudeCodeDateFingerprintInAnthropicRequest(input);

    expect(out.normalized).toBe(true);
    expect(out.body).toEqual({
      ...input,
      system: [
        { type: "text", text: "Today's date is 2026-07-01." },
        { type: "text", text: "Today's date is 2026-07-02." },
        { type: "text", text: "Today's date is 2026-07-03.", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  it("normalizes fingerprint markers in every message text surface", () => {
    const input = {
      model: "claude-3-5-sonnet",
      messages: [
        { role: "system", content: "Todayʹs date is 2026/07/01." },
        {
          role: "developer",
          content: [{ type: "text", text: "Todayʼs date is 2026/07/02." }],
        },
        { role: "user", content: "quote: Todayʼs date is 2026/07/03." },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant saw Today’s date is 2026/07/04." }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [{ type: "text", text: "tool says Today's date is 2026/07/05." }],
            },
          ],
        },
      ],
    };

    const out = normalizeClaudeCodeDateFingerprintInAnthropicRequest(input);

    expect(out.normalized).toBe(true);
    expect(out.body).toEqual({
      ...input,
      messages: [
        { role: "system", content: "Today's date is 2026-07-01." },
        {
          role: "developer",
          content: [{ type: "text", text: "Today's date is 2026-07-02." }],
        },
        { role: "user", content: "quote: Today's date is 2026-07-03." },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant saw Today's date is 2026-07-04." }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [{ type: "text", text: "tool says Today's date is 2026-07-05." }],
            },
          ],
        },
      ],
    });
  });

  it("normalizes tool descriptions without touching non-prompt tool input data", () => {
    const input = {
      model: "claude-3-5-sonnet",
      tools: [
        {
          name: "date_check",
          description: "Tool instructions. Todayʹs date is 2026/07/06.",
          input_schema: {
            type: "object",
            properties: {
              literal: { const: "Todayʹs date is 2026/07/06." },
            },
          },
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "date_check",
              input: { literal: "Todayʹs date is 2026/07/06." },
            },
          ],
        },
      ],
    };

    const out = normalizeClaudeCodeDateFingerprintInAnthropicRequest(input);

    expect(out.normalized).toBe(true);
    expect(out.body).toEqual({
      ...input,
      tools: [
        {
          ...input.tools[0],
          description: "Tool instructions. Today's date is 2026-07-06.",
        },
      ],
    });
  });
});
