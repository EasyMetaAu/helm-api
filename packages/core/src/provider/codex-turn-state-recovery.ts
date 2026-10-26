function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A full HTTP input can be sent once without relying on the old routing hint.
 * Opaque reasoning is preserved; server-owned references and incomplete tool pairs
 * cannot establish a new account context. Unknown item shapes fail closed. */
export function hasStandaloneCodexHistory(body: Record<string, unknown>): boolean {
  if (
    body.store !== false ||
    body.previous_response_id != null ||
    body.conversation != null ||
    body.prompt != null ||
    body.background === true ||
    !Array.isArray(body.input)
  )
    return false;
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  let user = false;
  for (const item of body.input) {
    if (!record(item)) return false;
    const type = item.type ?? "message";
    if (type === "message") {
      if (!["user", "assistant", "developer", "system"].includes(String(item.role))) return false;
      user ||= item.role === "user";
      if (
        typeof item.content !== "string" &&
        (!Array.isArray(item.content) ||
          item.content.some(
            (part) =>
              !record(part) ||
              part.file_id != null ||
              !["input_text", "output_text", "text", "input_image", "refusal"].includes(
                String(part.type),
              ) ||
              (part.type === "input_image" && typeof part.image_url !== "string"),
          ))
      )
        return false;
    } else if (type === "function_call" || type === "custom_tool_call") {
      if (typeof item.call_id !== "string" || !item.call_id || seen.has(item.call_id)) return false;
      seen.add(item.call_id);
      pending.set(item.call_id, type);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string" || pending.get(item.call_id) !== type.slice(0, -7))
        return false;
      pending.delete(item.call_id);
    } else if (type !== "reasoning" && type !== "additional_tools") return false;
  }
  return user && pending.size === 0;
}
