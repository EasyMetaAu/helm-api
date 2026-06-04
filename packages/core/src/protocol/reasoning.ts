import type { IRContentPart, IRMessage, IRThinkingBlock } from "./ir.js";

// —— Reasoning/thinking bridge (P6) ————————————————————————————————————————————
// Reasoning crosses the protocol layer in TWO interchangeable IR shapes:
//   1. a {type:"thinking"} CONTENT PART   — the content-block form, native to
//      Anthropic (thinking block) and OpenAI-Responses (reasoning item), and the
//      form Gemini thought parts normalize into.
//   2. the FLAT message fields            — `reasoning_content` (a single string,
//      DeepSeek/Groq/o-series/litellm `_extract_reasoning_content`) plus
//      `thinking_blocks[]` (the structured Anthropic form that preserves the
//      signature). litellm keeps reasoning_content and thinking_blocks as two
//      independent parallel fields and STRIPS reasoning out of `content`.
//
// For reasoning to round-trip THROUGH the IR across all four protocols, every
// transformer must populate AND read BOTH shapes. This module is the single place
// that converts between them (architecture rule: never invent parallel shapes).
//
// Pure, framework-free (CLAUDE.md principle 1); no `any`.

/** A thinking content part (the IRThinkingPart shape, narrowed locally for reuse). */
export type IRThinkingPart = Extract<IRContentPart, { type: "thinking" }>;

function isThinkingPart(part: IRContentPart): part is IRThinkingPart {
  return part.type === "thinking";
}

/**
 * Lift thinking that lives in a message's content parts onto the FLAT carriers
 * (`reasoning_content` + `thinking_blocks`) WITHOUT mutating the input. Used by
 * inbound (native -> IR) transformers (Anthropic / Responses / Gemini) so a
 * downstream OpenAI client — which reads `message.reasoning_content`, not a
 * content-block thinking part — still receives the reasoning.
 *
 * - reasoning_content: the thinking texts joined with "\n" (only when non-empty),
 *   matching litellm's single flat reasoning string.
 * - thinking_blocks: one structured block per thinking part, preserving the
 *   signature so a signed Anthropic block can be reconstructed losslessly.
 * Existing flat fields already on the message are preserved (not overwritten).
 */
export function liftReasoningToFlat(message: IRMessage): IRMessage {
  const { content } = message;
  if (!Array.isArray(content)) return message;
  const thinkingParts = content.filter(isThinkingPart);
  if (thinkingParts.length === 0) return message;

  const flatText = thinkingParts
    .map((p) => p.text)
    .filter((t) => t !== "")
    .join("\n");
  const blocks: IRThinkingBlock[] = thinkingParts.map((p) => ({
    type: "thinking",
    thinking: p.text,
    ...(p.signature !== undefined ? { signature: p.signature } : {}),
  }));

  return {
    ...message,
    ...(message.reasoning_content == null && flatText !== ""
      ? { reasoning_content: flatText }
      : {}),
    ...(message.thinking_blocks === undefined ? { thinking_blocks: blocks } : {}),
  };
}

/**
 * Resolve the reasoning carried by a message into BOTH a flat string and a list of
 * thinking content parts, drawing from whichever IR shape is populated. Outbound
 * (IR -> native) transformers call this so reasoning that arrived via the flat
 * carriers (e.g. from OpenAI `reasoning_content`, or an upstream `thinking_blocks`)
 * still renders into the native content-block form, and vice-versa.
 *
 * Precedence for the structured parts: explicit thinking content parts win; else
 * thinking_blocks (signature preserved); else a single synthetic part from the flat
 * reasoning_content string. The flat string mirrors the same source.
 */
export function resolveReasoning(message: IRMessage): {
  reasoningText: string | undefined;
  thinkingParts: IRThinkingPart[];
} {
  const { content } = message;
  const contentThinking = Array.isArray(content) ? content.filter(isThinkingPart) : [];

  if (contentThinking.length > 0) {
    const text = contentThinking
      .map((p) => p.text)
      .filter((t) => t !== "")
      .join("\n");
    return {
      reasoningText: text !== "" ? text : (message.reasoning_content ?? undefined),
      thinkingParts: contentThinking,
    };
  }

  if (message.thinking_blocks !== undefined && message.thinking_blocks.length > 0) {
    const parts: IRThinkingPart[] = message.thinking_blocks.map((b) => ({
      type: "thinking",
      text: b.thinking ?? "",
      ...(b.signature !== undefined ? { signature: b.signature } : {}),
    }));
    const text = parts
      .map((p) => p.text)
      .filter((t) => t !== "")
      .join("\n");
    return {
      reasoningText: text !== "" ? text : (message.reasoning_content ?? undefined),
      thinkingParts: parts,
    };
  }

  const flat = message.reasoning_content;
  if (flat != null && flat !== "") {
    return { reasoningText: flat, thinkingParts: [{ type: "thinking", text: flat }] };
  }

  return { reasoningText: undefined, thinkingParts: [] };
}

/**
 * Drop thinking content parts from a message's content (used where the target
 * protocol carries reasoning OUT-OF-BAND, e.g. OpenAI Chat `reasoning_content`,
 * so a {type:"thinking"} part must not leak into the OpenAI `content` array).
 * Returns the content unchanged when it is a string or has no thinking parts.
 */
export function stripThinkingFromContent(content: IRMessage["content"]): IRMessage["content"] {
  if (!Array.isArray(content)) return content;
  const kept = content.filter((p) => p.type !== "thinking");
  if (kept.length === content.length) return content;
  return kept.length > 0 ? kept : "";
}
