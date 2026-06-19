import type { InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { wrapMemoryReminder } from "../memory/inject-bridge.js";
import { lastUserMessage, lastUserMessageChars, lastUserMessageText } from "./message-text.js";

type Messages = InternalRequest["messages"];

// The memory-inject bridge appends its block as a trailing role:"user" turn wrapped
// in <system-reminder>…</system-reminder> (inject-bridge.wrapMemoryReminder). By the
// bridge's own contract that turn is "injected operator context, not the user
// speaking", so the classifier's notion of "the current user turn" must skip it and
// read the real prompt — otherwise task/complexity is scored on memory text and the
// genuine request is ignored. These pin that contract using the REAL producer so the
// two can never drift.
describe("lastUserMessage skips injected <system-reminder> turns", () => {
  const reminder = wrapMemoryReminder("Known facts:\n- the user likes the number 42");

  it("returns the real prior user turn, not the trailing memory reminder", () => {
    const messages: Messages = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "refactor this function and fix the failing unit test" },
      { role: "assistant", content: "done" },
      { role: "user", content: reminder },
    ];
    const msg = lastUserMessage(messages);
    expect(msg?.content).toBe("refactor this function and fix the failing unit test");
    expect(lastUserMessageText(messages)).toContain("refactor this function");
    expect(lastUserMessageText(messages)).not.toContain("<system-reminder>");
  });

  it("counts chars of the real prompt, not the (window-variable) reminder", () => {
    const messages: Messages = [
      { role: "user", content: "ok" },
      { role: "user", content: reminder },
    ];
    expect(lastUserMessageChars(messages)).toBe(2); // "ok", not the long reminder
  });

  it("ignores a reminder even when it is the only user-role turn", () => {
    const messages: Messages = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: reminder },
    ];
    expect(lastUserMessage(messages)).toBeNull();
    expect(lastUserMessageText(messages)).toBe("");
  });

  it("is unaffected when there is no injected reminder", () => {
    const messages: Messages = [{ role: "user", content: "hello there" }];
    expect(lastUserMessageText(messages)).toBe("hello there");
  });
});
