import { wrapMemoryReminder } from "@helm/core";

// native-memory-inject (#217 Phase 4 TRAILING-REMINDER model). When memory inject runs
// AND the request is native-passthrough eligible, the pipeline must add the assembled
// memory block to the VERBATIM native carrier WITHOUT touching the live conversation's
// existing turns OR the system-level field — memory rides ONE trailing
// `<system-reminder>` turn AFTER the conversation. These helpers splice that turn into
// the protocol-native conversation field:
//   - Anthropic `messages` is an array of turns (top-level field, sibling of `system`).
//   - Responses `input` is a string OR an array of items (sibling of `instructions`).
// In every case `system` / `instructions` (and every existing turn) are kept VERBATIM
// (by reference where possible) and a NEW body is returned — the input body is NEVER
// mutated.
//
// WHY TRAILING, not the system-level prefix the first Phase-4 cut used (cache-preserve
// revision of decision #3): Anthropic/Responses prompt caching is a strict prefix match
// (tools → system → messages). Prepending memory into `system` / `instructions` shifts
// the client's cached prefix — busting the cache that Claude Code / Codex marked with
// `cache_control` — every memory-mode turn, and the memory block is itself window-
// variable so it could never settle in a cached prefix. Appending the reminder AFTER the
// cached prefix leaves the cache fully intact; only the small reminder turn is uncached.
// The `<system-reminder>` wrapper (shared with the translate path via core's
// `wrapMemoryReminder`) keeps system-AUTHORITY framing without a model-gated beta header.

type Body = Record<string, unknown>;

// Anthropic: append the memory reminder as a trailing `{ role:"user" }` turn on
// `messages`. `system` and every existing turn are kept VERBATIM (by reference). When
// `messages` is absent the reminder becomes the lone turn. Returns a NEW body.
export function appendMemoryToAnthropicBody(body: Body, memoryBlock: string): Body {
  const reminder = { role: "user", content: wrapMemoryReminder(memoryBlock) };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return { ...body, messages: [...messages, reminder] };
}

// Responses: append the memory reminder AFTER the conversation. `input` is a string OR
// an array of items; `instructions` (the system-equivalent) is kept VERBATIM.
//   - array  → push a trailing `{ role:"user" }` input item.
//   - string → append as trailing text (`<input>\n\n<reminder>`) — keeps the cached
//     prefix intact for the common single-prompt shape.
//   - absent / empty → the reminder becomes the input string.
// Returns a NEW body — the input is never mutated.
export function appendMemoryToResponsesBody(body: Body, memoryBlock: string): Body {
  const reminderText = wrapMemoryReminder(memoryBlock);
  const input = body.input;
  if (Array.isArray(input)) {
    return { ...body, input: [...input, { role: "user", content: reminderText }] };
  }
  if (typeof input === "string" && input.length > 0) {
    return { ...body, input: `${input}\n\n${reminderText}` };
  }
  return { ...body, input: reminderText };
}

// Gemini: append the memory reminder as a trailing `{ role:"user", parts:[{text}] }`
// turn on `contents` (the protocol-native conversation field — sibling of the
// system-equivalent `systemInstruction`, which is kept VERBATIM). Every existing turn
// rides through by reference; when `contents` is absent the reminder becomes the lone
// turn. Returns a NEW body — the input is never mutated. Mirrors the Anthropic helper
// (trailing user turn, system-level field untouched) so memory rides AFTER the cached
// prefix on the Gemini native-passthrough path too.
export function appendMemoryToGeminiBody(body: Body, memoryBlock: string): Body {
  const reminder = { role: "user", parts: [{ text: wrapMemoryReminder(memoryBlock) }] };
  const contents = Array.isArray(body.contents) ? body.contents : [];
  return { ...body, contents: [...contents, reminder] };
}
