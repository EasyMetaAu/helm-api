// Gemini accepts a narrow OpenAPI-ish schema subset for function parameters and
// responseSchema. This sanitizer keeps requests out of upstream 400s while
// preserving as much shape as possible from common OpenAI/Zod JSON Schema.

// The small set of `format` values Gemini's OpenAPI subset does accept (numbers).
// Everything else is stripped. Kept deliberately narrow: when in doubt, strip.
const SUPPORTED_FORMATS = new Set(["int32", "int64", "float", "double", "enum"]);

// `format` values that carry a date/time semantic. We drop the keyword AND, where
// the field is a string, record the intent in `description` so it isn't fully lost.
const DATE_FORMATS = new Set(["date", "date-time", "time", "duration"]);

// Unsupported keywords that cannot be lowered safely. `$ref` and combinators are
// handled before this strip list so common schemas do not collapse to `{}`.
const UNSUPPORTED_KEYS = new Set([
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "unevaluatedProperties",
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

function mergeObjects(left: Record<string, unknown>, right: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...left, ...right };
  if (isPlainObject(left.properties) || isPlainObject(right.properties)) {
    out.properties = {
      ...(isPlainObject(left.properties) ? left.properties : {}),
      ...(isPlainObject(right.properties) ? right.properties : {}),
    };
  }
  const leftRequired = Array.isArray(left.required) ? left.required : [];
  const rightRequired = Array.isArray(right.required) ? right.required : [];
  if (leftRequired.length > 0 || rightRequired.length > 0) {
    out.required = Array.from(new Set([...leftRequired, ...rightRequired]));
  }
  return out;
}

function mergeSanitizedBranches(branches: unknown[]) {
  return branches.reduce<Record<string, unknown>>((acc, branch) => {
    if (!isPlainObject(branch)) return acc;
    return mergeObjects(acc, branch);
  }, {});
}

function firstRepresentable(branches: unknown[]) {
  return branches.find((branch) => {
    if (!isPlainObject(branch)) return branch !== undefined;
    if (branch.type === "null") return false;
    return Object.keys(branch).length > 0;
  });
}

function sanitize(schema: unknown, root: unknown, seen: Set<string>): unknown {
  if (Array.isArray(schema)) return schema.map((s) => sanitize(s, root, seen));
  if (!isPlainObject(schema)) return schema;

  let working: Record<string, unknown> = schema;
  const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (ref !== undefined && !seen.has(ref)) {
    const resolved = localRef(root, ref);
    if (resolved !== undefined) {
      const siblings = { ...schema };
      delete siblings.$ref;
      seen.add(ref);
      const base = sanitize(resolved, root, seen);
      seen.delete(ref);
      working = isPlainObject(base) ? mergeObjects(base, siblings) : siblings;
    }
  }

  const out: Record<string, unknown> = {};

  if (Array.isArray(working.allOf)) {
    Object.assign(out, mergeSanitizedBranches(working.allOf.map((s) => sanitize(s, root, seen))));
  }
  const unionBranches = Array.isArray(working.oneOf)
    ? working.oneOf
    : Array.isArray(working.anyOf)
      ? working.anyOf
      : undefined;
  if (unionBranches !== undefined) {
    const picked = firstRepresentable(unionBranches.map((s) => sanitize(s, root, seen)));
    if (isPlainObject(picked)) Object.assign(out, picked);
  }

  const siblings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(working)) {
    if (key === "$ref" || key === "allOf" || key === "oneOf" || key === "anyOf") continue;
    if (UNSUPPORTED_KEYS.has(key)) continue;
    if (key === "format") continue; // handled explicitly below
    if (key === "properties" && isPlainObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = sanitize(propSchema, root, seen);
      }
      siblings[key] = props;
      continue;
    }
    if (key === "items" && (isPlainObject(value) || Array.isArray(value))) {
      siblings[key] = sanitize(value, root, seen);
      continue;
    }
    siblings[key] = value;
  }

  const format = working.format;
  if (typeof format === "string" && format !== "") {
    if (SUPPORTED_FORMATS.has(format)) {
      siblings.format = format;
    } else if (DATE_FORMATS.has(format)) {
      if (siblings.type === undefined || siblings.type === "string") siblings.type = "string";
      const existing = typeof siblings.description === "string" ? siblings.description : "";
      const hint = `format: ${format}`;
      siblings.description = existing === "" ? hint : `${existing} (${hint})`;
    }
  }

  return mergeObjects(out, siblings);
}

/**
 * Recursively sanitize a JSON Schema for the Gemini OpenAPI subset. Returns a NEW
 * value and never mutates the input.
 * - Unsupported `format` keywords are removed.
 * - date/time string formats are downgraded to plain strings with description hints.
 * - Local `$ref` entries are resolved before unsupported keywords are stripped.
 * - `allOf` branches are merged; `oneOf`/`anyOf` choose the first representable
 *   non-null branch so common Zod/OpenAI schemas do not become `{}`.
 */
export function sanitizeSchema(schema: unknown): unknown {
  return sanitize(schema, schema, new Set());
}
