// native-memory-inject (#217 Phase 4 PREFIX model). When memory inject runs AND the
// request is native-passthrough eligible, the pipeline must add the assembled memory
// TEXT BLOCK to the VERBATIM native carrier WITHOUT touching the live conversation —
// memory is purely additive at the SYSTEM level (decision #3). These helpers splice the
// block into the protocol-native system field:
//   - Anthropic `system` is a string OR an array of content blocks (top-level field,
//     SIBLING of `messages`).
//   - Responses `instructions` is a string (top-level field, SIBLING of `input`).
// In every case `messages` / `input` are kept BY REFERENCE (verbatim) and a NEW body is
// returned — the input body is NEVER mutated, so the passthrough forward stays
// byte-faithful except for the one additive prefix. This is what lets passthrough fire
// WITH memory: the guard no longer disables inject (the request is consistent — memory in
// system/instructions, live turns untouched).

type Body = Record<string, unknown>;

// Anthropic top-level `system` may be a STRING or an ARRAY of content blocks.
// - string: prepend the block + blank-line separator (or the block alone if absent/empty).
// - array: prepend ONE { type:"text", text: block } block ahead of the client's blocks.
// `messages` and every other field are kept verbatim (by reference). Returns a NEW body.
export function prependMemoryToAnthropicBody(body: Body, memoryBlock: string): Body {
  const system = body.system;
  if (Array.isArray(system)) {
    return { ...body, system: [{ type: "text", text: memoryBlock }, ...system] };
  }
  if (typeof system === "string" && system.length > 0) {
    return { ...body, system: `${memoryBlock}\n\n${system}` };
  }
  // Absent / empty / non-string system → the memory block becomes the system prompt.
  return { ...body, system: memoryBlock };
}

// Responses `instructions` is a STRING. Prepend the block + blank-line separator (or the
// block alone if absent/empty). `input` and every other field are kept verbatim. Returns
// a NEW body — the input is never mutated.
export function prependMemoryToResponsesBody(body: Body, memoryBlock: string): Body {
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions.length > 0) {
    return { ...body, instructions: `${memoryBlock}\n\n${instructions}` };
  }
  return { ...body, instructions: memoryBlock };
}
