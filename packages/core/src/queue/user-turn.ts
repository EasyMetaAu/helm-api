// Pure detector for the per-account user-message serial queue (issue #93,
// feature B): only requests whose LAST Chat message or Responses input item is
// a genuine user turn are serialized — tool-result round-trips and
// assistant/system continuations flow freely (they are mid-agent-loop and
// delaying them would only slow the loop without protecting upstream rate limits).
//
// At the provider layer messages are OpenAI-shaped, where tool results carry
// role "tool" — so the role check alone covers the normal path. The content
// array is additionally screened for Anthropic-shaped tool blocks
// (`tool_result` / `tool_use_result` / a `tool_use_id`-bearing part) as cheap
// insurance against any pass-through shape. Malformed input => false
// (fail-safe: never serialize what we cannot classify).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (isRecord(part)) {
      if (
        part.type === "tool_result" ||
        part.type === "tool_use_result" ||
        part.type === "tool_use"
      ) {
        return true;
      }
      if (part.tool_use_id !== undefined || part.tool_call_id !== undefined) return true;
    }
  }
  return false;
}

export function isUserMessageRequest(req: { messages?: unknown; input?: unknown }): boolean {
  const messages = req.messages;
  if (Array.isArray(messages)) {
    if (messages.length === 0) return false;
    const last: unknown = messages[messages.length - 1];
    if (!isRecord(last)) return false;
    if (last.role !== "user") return false;
    return !isToolResultContent(last.content);
  }

  const input = req.input;
  if (typeof input === "string") return input.trim().length > 0;
  if (!Array.isArray(input) || input.length === 0) return false;
  const last: unknown = input[input.length - 1];
  if (!isRecord(last)) return false;
  if (last.type === "function_call_output" || last.type === "reasoning") return false;
  if (last.role !== "user") return false;
  return !isToolResultContent(last.content);
}
