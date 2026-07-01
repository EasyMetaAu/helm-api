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

  it("normalizes system and developer message text without touching ordinary user text", () => {
    const input = {
      model: "claude-3-5-sonnet",
      messages: [
        { role: "system", content: "Todayʹs date is 2026/07/01." },
        {
          role: "developer",
          content: [{ type: "text", text: "Todayʼs date is 2026/07/02." }],
        },
        { role: "user", content: "quote: Todayʼs date is 2026/07/03." },
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
        { role: "user", content: "quote: Todayʼs date is 2026/07/03." },
      ],
    });
  });
});
