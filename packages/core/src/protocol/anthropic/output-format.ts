// Anthropic structured-output (output_format) schema filter (docs/05, issue #59).
//
// Anthropic's newer structured-output API takes an `output_format` of shape
//   { type: "json_schema", schema: <JSON Schema> }
// but its schema dialect does NOT accept the numeric/string/array constraint
// keywords that an OpenAI `response_format.json_schema` may carry. Per public
// LiteLLM BEHAVIOR (anthropic/chat/transformation.py
// `filter_anthropic_output_schema` + `map_response_format_to_anthropic_output_format`)
// — referenced, NOT copied — the SDK strategy is:
//   1. resolve local `$ref`/`$defs` (Anthropic rejects external references), and
//   2. drop the unsupported constraint keywords, recording each dropped value in
//      the field's `description` so the intent is not silently lost.
//
// Pure, framework-agnostic (CLAUDE.md principle 1). No `any`.

// The constraint keywords Anthropic's output_format does NOT support (LiteLLM
// `filter_anthropic_output_schema`). Each is dropped and, when present, folded
// into the owning field's description as a human-readable hint.
const UNSUPPORTED_CONSTRAINTS: Record<string, (v: unknown) => string> = {
  minItems: (v) => `minimum number of items: ${String(v)}`,
  maxItems: (v) => `maximum number of items: ${String(v)}`,
  minimum: (v) => `minimum value: ${String(v)}`,
  maximum: (v) => `maximum value: ${String(v)}`,
  exclusiveMinimum: (v) => `exclusive minimum value: ${String(v)}`,
  exclusiveMaximum: (v) => `exclusive maximum value: ${String(v)}`,
  minLength: (v) => `minimum length: ${String(v)}`,
  maxLength: (v) => `maximum length: ${String(v)}`,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function localRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    if (!isPlainObject(cur)) return undefined;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = cur[key];
  }
  return cur;
}

function filter(schema: unknown, root: unknown, seen: Set<string>): unknown {
  if (Array.isArray(schema)) return schema.map((s) => filter(s, root, seen));
  if (!isPlainObject(schema)) return schema;

  let working: Record<string, unknown> = schema;
  // Resolve a local $ref before filtering — Anthropic rejects external references.
  const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (ref !== undefined && !seen.has(ref)) {
    const resolved = localRef(root, ref);
    if (isPlainObject(resolved)) {
      const siblings = { ...schema };
      delete siblings.$ref;
      seen.add(ref);
      const base = filter(resolved, root, seen) as Record<string, unknown>;
      seen.delete(ref);
      working = { ...base, ...siblings };
    }
  }

  const out: Record<string, unknown> = {};
  const droppedHints: string[] = [];

  for (const [key, value] of Object.entries(working)) {
    if (key === "$ref") continue;
    // Strip $defs/definitions — they have been (or will be) inlined via $ref.
    if (key === "$defs" || key === "definitions") continue;
    if (key in UNSUPPORTED_CONSTRAINTS) {
      const label = UNSUPPORTED_CONSTRAINTS[key];
      if (label !== undefined) droppedHints.push(label(value));
      continue;
    }
    if (key === "properties" && isPlainObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = filter(propSchema, root, seen);
      }
      out.properties = props;
      continue;
    }
    if (key === "items" && (isPlainObject(value) || Array.isArray(value))) {
      out.items = filter(value, root, seen);
      continue;
    }
    out[key] = value;
  }

  if (droppedHints.length > 0) {
    const existing = typeof out.description === "string" ? out.description : "";
    const hint = droppedHints.join("; ");
    out.description = existing === "" ? hint : `${existing} (${hint})`;
  }

  return out;
}

/**
 * Filter a JSON Schema for Anthropic's `output_format` structured-output API.
 * Returns a NEW value; never mutates the input. Drops the unsupported numeric/
 * string/array constraint keywords (recording each in `description`) and resolves
 * local `$ref`/`$defs`. Policy referenced from public LiteLLM behavior — no code copied.
 */
export function filterAnthropicOutputSchema(schema: unknown): unknown {
  return filter(schema, schema, new Set());
}

export interface AnthropicOutputFormat {
  type: "json_schema";
  schema: unknown;
}

/**
 * Map an IR/OpenAI `response_format` to an Anthropic `output_format`. Returns
 * undefined for a non-JSON / text response_format (no structured output requested).
 * A bare `json_object` (no schema) cannot express a schema in this API, so it maps
 * to undefined — JSON mode without a schema is left to the model's instructions.
 */
export function responseFormatToOutputFormat(
  responseFormat: unknown,
): AnthropicOutputFormat | undefined {
  if (!isPlainObject(responseFormat)) return undefined;
  const type = responseFormat.type;
  if (type !== "json_schema") return undefined;

  const rawSchema = responseFormat.json_schema;
  const schema =
    isPlainObject(rawSchema) && "schema" in rawSchema
      ? (rawSchema as { schema?: unknown }).schema
      : rawSchema;
  if (schema === undefined) return undefined;

  return { type: "json_schema", schema: filterAnthropicOutputSchema(schema) };
}
