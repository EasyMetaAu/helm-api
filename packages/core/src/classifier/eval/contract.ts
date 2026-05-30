import { type EvalOutput, EvalOutputSchema } from "@helm/shared";

// eval.contract — fail-open parser for the Layer-2 small-model output. The model
// output is UNTRUSTED external input. This is a PURE function with zero network
// (parsing + validation only); `eval.client` feeds the network result in. It
// NEVER throws — on any failure it returns a discriminated `{ ok:false, reason }`
// so `eval.cascade` can fail-open to the balanced lane and write the failure
// reason into the decision record (CLAUDE.md principle 3; docs/03 Layer 2).
//
// Tolerances: strip an optional ```json fence and leading prose, then take the
// first `{...}` segment. NO lowercase / synonym normalization — enums must match
// exactly (fuzzy matching would mask model drift). `confidence` out of range is
// schema_invalid (no clamp). This function does NOT reference the `lane`
// concept — translating fail-open into the balanced lane is eval.cascade's job
// (single responsibility; core stays framework/route agnostic).

export type EvalParseResult =
  | { ok: true; value: EvalOutput }
  | { ok: false; reason: "not_json" | "schema_invalid"; raw: string };

/**
 * Extract the first balanced `{...}` object from arbitrary text. Tolerates a
 * leading ```json fence and surrounding prose. Returns `null` when no balanced
 * object can be found. String-literal aware so braces inside string values do
 * not confuse the depth counter; never throws.
 */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  // Unbalanced (e.g. truncated JSON) — no complete object available.
  return null;
}

export function parseEvalOutput(rawText: string): EvalParseResult {
  const candidate = extractFirstObject(rawText);
  if (candidate === null) {
    return { ok: false, reason: "not_json", raw: rawText };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "not_json", raw: rawText };
  }

  const result = EvalOutputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "schema_invalid", raw: rawText };
  }

  return { ok: true, value: result.data };
}
