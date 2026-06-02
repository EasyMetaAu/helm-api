// JSON-Schema `format` sanitizer (docs/05 "cross-cutting concerns as stackable
// transformers"). Gemini's functionDeclarations[].parameters accept only an
// OpenAPI 3.0 subset: the JSON-Schema `format` keyword is largely unsupported, and
// passing e.g. `format:"date"` / `"date-time"` makes the upstream reject the
// request with a 400. The contract from the task spec: STRIP unsupported `format`
// values and DOWNGRADE date/date-time string fields to a plain string (folding the
// lost semantic into `description` so the model still gets the hint). It is better
// to degrade the semantic than to let the upstream 400 (fail-open, principle 3).
//
// Pure, recursive, framework-agnostic (principle 1). It is protocol-agnostic on
// purpose — any provider that needs OpenAPI-subset schemas can reuse it. No `any`.

// The small set of `format` values Gemini's OpenAPI subset does accept (numbers).
// Everything else is stripped. Kept deliberately narrow: when in doubt, strip.
const SUPPORTED_FORMATS = new Set(["int32", "int64", "float", "double", "enum"]);

// `format` values that carry a date/time semantic. We drop the keyword AND, where
// the field is a string, record the intent in `description` so it isn't fully lost.
const DATE_FORMATS = new Set(["date", "date-time", "time", "duration"]);

// Gemini accepts a narrow OpenAPI-ish schema subset. Strip JSON Schema draft and
// validation keywords that Gemini does not understand instead of forwarding a
// request that upstream rejects with 400.
const UNSUPPORTED_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "unevaluatedProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "const",
  "default",
  "examples",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recursively sanitize a JSON Schema for the Gemini OpenAPI subset. Returns a NEW
 * value (never mutates the input, so it is composable like a behavior transformer).
 * - Unsupported `format` keywords are removed.
 * - A `date`/`date-time`/`time`/`duration` format on a string degrades to a plain
 *   string and the original format is appended to `description` as a hint.
 * - Recurses through `properties`, `items`, `$defs`/`definitions`, and the
 *   `anyOf`/`oneOf`/`allOf` combinators; all other structure is preserved verbatim.
 */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((s) => sanitizeSchema(s));
  }
  if (!isPlainObject(schema)) return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    if (key === "format") continue; // handled explicitly below
    if (key === "properties" && isPlainObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = sanitizeSchema(propSchema);
      }
      out[key] = props;
      continue;
    }
    if (
      (key === "items" ||
        key === "additionalProperties" ||
        key === "not" ||
        key === "$defs" ||
        key === "definitions") &&
      (isPlainObject(value) || Array.isArray(value))
    ) {
      out[key] = sanitizeSchema(value);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map((s) => sanitizeSchema(s));
      continue;
    }
    out[key] = value;
  }

  // Now decide what to do with the original `format`, if any.
  const format = schema.format;
  if (typeof format === "string" && format !== "") {
    if (SUPPORTED_FORMATS.has(format)) {
      out.format = format; // keep the few formats Gemini understands
    } else if (DATE_FORMATS.has(format)) {
      // Downgrade to a plain string; fold the semantic into description.
      if (out.type === undefined || out.type === "string") out.type = "string";
      const existing = typeof out.description === "string" ? out.description : "";
      const hint = `format: ${format}`;
      out.description = existing === "" ? hint : `${existing} (${hint})`;
    }
    // any other unsupported format is simply dropped (already skipped above).
  }

  return out;
}
