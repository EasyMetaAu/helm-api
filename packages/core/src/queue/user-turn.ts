// Pure detector for the per-account user-message serial queue (issue #93,
// feature B): only requests whose LAST message is a genuine user turn are
// serialized — tool-result round-trips and assistant/system continuations flow
// freely (they are mid-agent-loop and delaying them would only slow the loop
// without protecting upstream rate limits).
//
// At the provider layer messages are OpenAI-shaped, where tool results carry
// role "tool" — so the role check alone covers the normal path. The content
// array is additionally screened for Anthropic-shaped tool blocks
// (`tool_result` / `tool_use_result` / a `tool_use_id`-bearing part) as cheap
// insurance against any pass-through shape. Malformed input => false
// (fail-safe: never serialize what we cannot classify).

export function isUserMessageRequest(req: { messages?: unknown }): boolean {
  const messages = req.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last: unknown = messages[messages.length - 1];
  if (typeof last !== "object" || last === null) return false;
  const { role, content } = last as { role?: unknown; content?: unknown };
  if (role !== "user") return false;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "object" && part !== null) {
        const p = part as { type?: unknown; tool_use_id?: unknown; tool_call_id?: unknown };
        if (p.type === "tool_result" || p.type === "tool_use_result" || p.type === "tool_use") {
          return false;
        }
        if (p.tool_use_id !== undefined || p.tool_call_id !== undefined) return false;
      }
    }
  }
  return true;
}
