import type { InternalRequest } from "@helm/shared";

// Shared message-text extraction for the Layer-1 classifier. PURE (CLAUDE.md
// principle 4): zero I/O, no clock, no randomness. These helpers were previously
// duplicated in engine.ts and eval/cache-key.ts — kept here as the single source
// so the scoring path, the language guard, and the eval cache key can never drift
// on what "the current user turn" means.
//
// WHY last-user-only matters: a request's task/intent lives in the CURRENT user
// turn, not in a constant system/developer prompt that ships with every turn of an
// agent. Scoring the concatenated history lets a large system prompt's incidental
// words ("实现", "git state", "人类") dominate a trivial question. taskdetect.ts and
// engine.ts's language guard both rely on this scoping (see engine.ts §5.5).
//
// INJECTED-REMINDER SKIP: in memory-inject mode the bridge APPENDS its memory block
// as a trailing role:"user" turn wrapped in <system-reminder>…</system-reminder>
// (memory/inject-bridge.ts wrapMemoryReminder), and the gateway classifies the
// post-injection messages. By the bridge's own contract that turn is "injected
// operator context, not the user speaking" — so we skip it and read the real last
// user turn. Skipping here fixes task + complexity + momentum + the language guard
// in one place, and keeps the eval cache key stable (the memory block is
// window-variable, so keying on it would tank the hit rate). The marker literal is
// duplicated from inject-bridge intentionally (classifier must not import memory);
// message-text.test.ts pins them together via the real wrapMemoryReminder.

type Messages = InternalRequest["messages"];

// Last role==="user" message object, scanning backwards from the end, SKIPPING
// injected <system-reminder> turns (see header). null when there is no real user
// message. Robust to the MVP's open message shape (role is a free string;
// "system"/"developer"/"assistant"/"tool" are skipped).
export function lastUserMessage(messages: Messages): Messages[number] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === "user" && !isInjectedReminder(msg.content)) return msg;
  }
  return null;
}

// True when a user turn's content is a memory-injected <system-reminder> envelope
// (inject-bridge.wrapMemoryReminder). Reads the flattened text so an array-shaped
// content part is handled too.
function isInjectedReminder(content: unknown): boolean {
  return contentToString(content).trimStart().startsWith("<system-reminder>");
}

// Last user message content flattened to a string (NOT trimmed; callers trim if
// they need to). "" when there is no user message.
export function lastUserMessageText(messages: Messages): string {
  const msg = lastUserMessage(messages);
  return msg ? contentToString(msg.content) : "";
}

// Trimmed character length of the last user message — the short-message / momentum
// measure used by engine.ts.
export function lastUserMessageChars(messages: Messages): number {
  return lastUserMessageText(messages).trim().length;
}

// Flatten message content into a string. Reads string content and the string
// `text` parts of array content (vision/tool blocks etc.); ignores non-string
// parts. Never throws.
export function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("\n");
  }
  return "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
