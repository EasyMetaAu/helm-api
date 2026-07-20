export interface RecoveredToolCall {
  name: string;
  input: Record<string, unknown>;
}

export type RecoverySegment =
  | { type: "text"; text: string }
  | { type: "tool_use"; call: RecoveredToolCall };

const BARE_INVOKE_START = '<invoke name="';
const ANTML_INVOKE_START = '<antml:invoke name="';
const INVOKE_STARTS = [BARE_INVOKE_START, ANTML_INVOKE_START] as const;

// The model-emitted grammar is deliberately narrow: exact lowercase tag names,
// double-quoted name attributes, and either a consistently bare or antml-prefixed
// open/close pair. Narrow matching is the whitelist's first false-positive guard.
function invokePattern(): RegExp {
  return /<(antml:)?invoke name="([^"]+)">([\s\S]*?)<\/\1invoke>/g;
}

function parameterPattern(): RegExp {
  return /<(antml:)?parameter name="([^"]+)">([\s\S]*?)<\/\1parameter>/g;
}

/** Cheap, case-sensitive gate for the overwhelmingly common no-leak path. */
export function hasInvokeStart(text: string): boolean {
  return invokeStartIndex(text) >= 0;
}

/** First complete opener, or -1. Shared by both streaming recovery paths. */
export function invokeStartIndex(text: string): number {
  let first = -1;
  for (const marker of INVOKE_STARTS) {
    const index = text.indexOf(marker);
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  return first;
}

/**
 * Length of the trailing text that could still become a complete opener after
 * the next delta. Zero means a streaming probe can be released immediately.
 */
export function invokeStartPrefixSuffixLength(text: string): number {
  const max = Math.min(text.length, Math.max(...INVOKE_STARTS.map((marker) => marker.length)) - 1);
  for (let length = max; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (INVOKE_STARTS.some((marker) => marker.startsWith(suffix))) return length;
  }
  return 0;
}

function coerceParameterValue(raw: string): unknown {
  const trimmed = raw.trim();
  const first = trimmed[0];
  const looksLikeJson =
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null" ||
    first === "-" ||
    first === "{" ||
    first === "[" ||
    first === '"' ||
    (first !== undefined && first >= "0" && first <= "9");

  if (!looksLikeJson) return raw;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    // JSON itself has no Infinity representation, and an unsafe integer would be
    // rounded before the tool sees it. Preserve those spellings as strings rather
    // than silently turning an argument into null or a different integer downstream.
    if (
      typeof parsed === "number" &&
      (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)))
    ) {
      return raw;
    }
    return parsed;
  } catch {
    // Invalid JSON-looking text is still a legitimate raw tool argument. Recovery
    // must never normalize or discard it merely because coercion was unsuccessful.
    return raw;
  }
}

function parseParameters(body: string): Record<string, unknown> {
  // A null-prototype dictionary makes even the magic `__proto__` spelling a plain
  // own data key. Duplicate names intentionally assign in source order, so the last
  // parameter wins without exposing Object.prototype to model-controlled mutation.
  const input = Object.create(null) as Record<string, unknown>;
  for (const match of body.matchAll(parameterPattern())) {
    const name = match[2];
    const value = match[3];
    if (name === undefined || value === undefined) continue;
    input[name] = coerceParameterValue(value);
  }
  return input;
}

function appendText(segments: RecoverySegment[], text: string): void {
  if (text === "") return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

/**
 * Lift each complete, declared XML invoke into an ordered tool-use segment.
 * Anything not recovered remains verbatim; null tells callers to retain the
 * original text object and avoid changing the normal response path at all.
 */
export function recoverToolCallsFromText(
  text: string,
  declaredTools: ReadonlySet<string>,
): RecoverySegment[] | null {
  if (declaredTools.size === 0 || !hasInvokeStart(text)) return null;

  const segments: RecoverySegment[] = [];
  let cursor = 0;
  let recovered = 0;

  for (const match of text.matchAll(invokePattern())) {
    const raw = match[0];
    const name = match[2];
    const body = match[3];
    const index = match.index;
    if (raw === undefined || name === undefined || body === undefined || index === undefined) {
      continue;
    }

    appendText(segments, text.slice(cursor, index));
    if (declaredTools.has(name)) {
      segments.push({
        type: "tool_use",
        call: { name, input: parseParameters(body) },
      });
      recovered += 1;
    } else {
      appendText(segments, raw);
    }
    cursor = index + raw.length;
  }

  if (recovered === 0) return null;
  appendText(segments, text.slice(cursor));
  return segments;
}

/**
 * The end_turn fallback is intentionally narrower than tool_use recovery: every
 * invoke must be declared and outside a Markdown code fence, and the final
 * meaningful segment must itself be a recovered tool call.
 */
export function recoverTerminalToolCallsFromText(
  text: string,
  declaredTools: ReadonlySet<string>,
): RecoverySegment[] | null {
  const segments = recoverToolCallsFromText(text, declaredTools);
  if (segments === null) return null;

  let fence = text.indexOf("```");
  let fences = 0;
  for (const match of text.matchAll(invokePattern())) {
    const index = match.index;
    if (index === undefined) return null;
    while (fence >= 0 && fence < index) {
      fences += 1;
      fence = text.indexOf("```", fence + 3);
    }
    if (fences % 2 === 1) return null;
  }

  const residualToolXml = /<\/?(?:[A-Za-z_][\w.-]*:)?(?:invoke|function_calls)\b/i;
  for (const segment of segments) {
    if (segment.type === "text" && residualToolXml.test(segment.text)) return null;
  }
  let recoveredToolSeen = false;
  for (const segment of segments) {
    if (segment.type === "tool_use") {
      recoveredToolSeen = true;
      continue;
    }
    // Leading prose may explain the action, but once execution begins, separate
    // recovered calls only with whitespace. This prevents an earlier un-fenced
    // XML example from becoming executable alongside the real terminal call.
    if (recoveredToolSeen && segment.text.trim() !== "") return null;
  }
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    if (segment.type === "tool_use") return segments;
    if (segment.text.trim() !== "") return null;
  }
  return null;
}
