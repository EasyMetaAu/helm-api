import { describe, expect, it } from "vitest";
import { filterAnthropicOutputSchema, responseFormatToOutputFormat } from "./output-format.js";

// Anthropic structured-output (output_format) schema filter (docs/05, issue #59).
// filterAnthropicOutputSchema drops the numeric/string/array constraint keywords that
// Anthropic's output_format dialect rejects — folding each dropped value into the
// owning field's `description` — and resolves local $ref/$defs. The whole module had
// no dedicated test; these cover the constraint drop, the description fold, the local
// $ref resolution path (localRef + the $ref branch), and responseFormatToOutputFormat.

describe("filterAnthropicOutputSchema — constraint dropping + description fold", () => {
  it("drops unsupported numeric constraints and folds them into description", () => {
    const filtered = filterAnthropicOutputSchema({
      type: "integer",
      minimum: 1,
      maximum: 10,
      exclusiveMinimum: 0,
      exclusiveMaximum: 11,
    }) as Record<string, unknown>;
    expect(filtered.minimum).toBeUndefined();
    expect(filtered.maximum).toBeUndefined();
    expect(filtered.exclusiveMinimum).toBeUndefined();
    expect(filtered.exclusiveMaximum).toBeUndefined();
    expect(filtered.type).toBe("integer");
    // every dropped value is recorded in the description (intent not silently lost).
    expect(filtered.description).toContain("minimum value: 1");
    expect(filtered.description).toContain("maximum value: 10");
    expect(filtered.description).toContain("exclusive minimum value: 0");
    expect(filtered.description).toContain("exclusive maximum value: 11");
  });

  it("drops string length + array item constraints", () => {
    const filtered = filterAnthropicOutputSchema({
      type: "string",
      minLength: 2,
      maxLength: 8,
    }) as Record<string, unknown>;
    expect(filtered.minLength).toBeUndefined();
    expect(filtered.maxLength).toBeUndefined();
    expect(filtered.description).toContain("minimum length: 2");
    expect(filtered.description).toContain("maximum length: 8");

    const arr = filterAnthropicOutputSchema({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    }) as Record<string, unknown>;
    expect(arr.minItems).toBeUndefined();
    expect(arr.maxItems).toBeUndefined();
    expect(arr.description).toContain("minimum number of items: 1");
    expect(arr.description).toContain("maximum number of items: 3");
  });

  it("appends dropped hints to an EXISTING description in parentheses", () => {
    const filtered = filterAnthropicOutputSchema({
      type: "integer",
      description: "the count",
      minimum: 0,
    }) as Record<string, unknown>;
    expect(filtered.description).toBe("the count (minimum value: 0)");
  });

  it("uses the hint AS the description when no description exists", () => {
    const filtered = filterAnthropicOutputSchema({
      type: "integer",
      minimum: 5,
    }) as Record<string, unknown>;
    expect(filtered.description).toBe("minimum value: 5");
  });

  it("recurses into properties and items, dropping nested constraints", () => {
    const filtered = filterAnthropicOutputSchema({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string", maxLength: 5 }, minItems: 1 },
      },
      required: ["name"],
    }) as Record<string, unknown>;
    const props = filtered.properties as Record<string, Record<string, unknown>>;
    expect(props.name?.minLength).toBeUndefined();
    expect(props.name?.description).toContain("minimum length: 1");
    const tags = props.tags as Record<string, unknown>;
    expect(tags.minItems).toBeUndefined();
    const tagItems = tags.items as Record<string, unknown>;
    expect(tagItems.maxLength).toBeUndefined();
    // required (a supported keyword) survives untouched.
    expect(filtered.required).toEqual(["name"]);
  });

  it("handles a tuple-style items ARRAY by filtering each element", () => {
    const filtered = filterAnthropicOutputSchema({
      type: "array",
      items: [
        { type: "string", minLength: 1 },
        { type: "integer", minimum: 0 },
      ],
    }) as Record<string, unknown>;
    const items = filtered.items as Array<Record<string, unknown>>;
    expect(items[0]?.minLength).toBeUndefined();
    expect(items[0]?.description).toContain("minimum length: 1");
    expect(items[1]?.minimum).toBeUndefined();
  });

  it("returns primitives and arrays unchanged at the top level", () => {
    expect(filterAnthropicOutputSchema("plain")).toBe("plain");
    expect(filterAnthropicOutputSchema(42)).toBe(42);
    expect(filterAnthropicOutputSchema(null)).toBeNull();
    // a top-level array maps each element through the filter.
    const arr = filterAnthropicOutputSchema([{ type: "string", minLength: 2 }]) as Array<
      Record<string, unknown>
    >;
    expect(arr[0]?.minLength).toBeUndefined();
  });
});

describe("filterAnthropicOutputSchema — local $ref/$defs resolution", () => {
  it("resolves a local $ref into the referenced subschema and strips $defs", () => {
    const filtered = filterAnthropicOutputSchema({
      type: "object",
      properties: {
        node: { $ref: "#/$defs/Node" },
      },
      $defs: {
        Node: { type: "string", minLength: 1 },
      },
    }) as Record<string, unknown>;
    // $defs is stripped from the output (inlined via $ref).
    expect(filtered.$defs).toBeUndefined();
    const props = filtered.properties as Record<string, Record<string, unknown>>;
    // the $ref was resolved to the Node schema, with its minLength dropped + folded.
    expect(props.node?.type).toBe("string");
    expect(props.node?.$ref).toBeUndefined();
    expect(props.node?.minLength).toBeUndefined();
    expect(props.node?.description).toContain("minimum length: 1");
  });

  it("merges sibling keys over the resolved $ref target", () => {
    // A $ref alongside sibling keys: the siblings win on conflict (base then siblings).
    const filtered = filterAnthropicOutputSchema({
      properties: {
        x: { $ref: "#/$defs/Base", description: "overridden" },
      },
      $defs: { Base: { type: "string", description: "base desc" } },
    }) as Record<string, unknown>;
    const props = filtered.properties as Record<string, Record<string, unknown>>;
    expect(props.x?.type).toBe("string");
    expect(props.x?.description).toBe("overridden");
  });

  it("resolves a $ref via legacy 'definitions' and decodes ~0/~1 pointer escapes", () => {
    // JSON-pointer escapes: ~1 -> "/", ~0 -> "~". Key here is "a/b~c".
    const filtered = filterAnthropicOutputSchema({
      properties: { ref: { $ref: "#/definitions/a~1b~0c" } },
      definitions: { "a/b~c": { type: "number", minimum: 3 } },
    }) as Record<string, unknown>;
    const props = filtered.properties as Record<string, Record<string, unknown>>;
    expect(props.ref?.type).toBe("number");
    expect(props.ref?.minimum).toBeUndefined();
    expect(props.ref?.description).toContain("minimum value: 3");
  });

  it("leaves a $ref in place when it does not resolve locally (external/missing)", () => {
    // localRef returns undefined for a non-'#/' ref → the $ref branch is skipped, and
    // the $ref key is then dropped by the key loop (Anthropic rejects external refs).
    const filtered = filterAnthropicOutputSchema({
      properties: { ext: { $ref: "https://example.com/schema.json" } },
    }) as Record<string, unknown>;
    const props = filtered.properties as Record<string, Record<string, unknown>>;
    // unresolvable ref leaves an (empty) object — $ref itself is stripped.
    expect(props.ext?.$ref).toBeUndefined();
  });

  it("does not infinitely recurse on a self-referential $ref (seen guard)", () => {
    // Node references itself; the `seen` set breaks the cycle.
    const filtered = filterAnthropicOutputSchema({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    }) as Record<string, unknown>;
    expect(filtered.type).toBe("object");
    const props = filtered.properties as Record<string, Record<string, unknown>>;
    // the inner self-ref hits the `seen` guard and is left as an (empty) object.
    expect(props.next).toBeDefined();
  });

  it("returns an unresolved ref when the pointer path traverses a non-object (line 38)", () => {
    // #/$defs/Leaf/child: Leaf is a string, so stepping into `child` hits the
    // non-object guard in localRef and the ref does not resolve.
    const filtered = filterAnthropicOutputSchema({
      properties: { bad: { $ref: "#/$defs/Leaf/child" } },
      $defs: { Leaf: "i am a string" },
    }) as Record<string, unknown>;
    const props = filtered.properties as Record<string, Record<string, unknown>>;
    expect(props.bad?.$ref).toBeUndefined();
    // unresolved → the husk is an empty object (no inlined keys).
    expect(Object.keys(props.bad ?? {})).toHaveLength(0);
  });

  it("returns a missing local pointer target as an empty object (unresolved)", () => {
    // #/$defs/Nope does not exist → localRef returns undefined → ref left, then stripped.
    const filtered = filterAnthropicOutputSchema({
      $ref: "#/$defs/Nope",
      $defs: { Other: { type: "string" } },
    }) as Record<string, unknown>;
    expect(filtered.$ref).toBeUndefined();
    expect(filtered.$defs).toBeUndefined();
  });
});

describe("responseFormatToOutputFormat", () => {
  it("returns undefined for a non-object response_format", () => {
    expect(responseFormatToOutputFormat(undefined)).toBeUndefined();
    expect(responseFormatToOutputFormat("text")).toBeUndefined();
    expect(responseFormatToOutputFormat(null)).toBeUndefined();
  });

  it("returns undefined for a text / json_object (no schema) response_format", () => {
    expect(responseFormatToOutputFormat({ type: "text" })).toBeUndefined();
    expect(responseFormatToOutputFormat({ type: "json_object" })).toBeUndefined();
  });

  it("maps a wrapped json_schema response_format to an Anthropic output_format", () => {
    const out = responseFormatToOutputFormat({
      type: "json_schema",
      json_schema: {
        name: "Person",
        schema: { type: "object", properties: { age: { type: "integer", minimum: 0 } } },
      },
    });
    expect(out?.type).toBe("json_schema");
    const schema = out?.schema as Record<string, Record<string, Record<string, unknown>>>;
    // the nested { schema } was unwrapped + filtered (minimum dropped + folded).
    expect(schema.properties?.age?.minimum).toBeUndefined();
    expect(schema.properties?.age?.description).toContain("minimum value: 0");
  });

  it("accepts a json_schema whose json_schema is the bare schema (no { schema } wrapper)", () => {
    const out = responseFormatToOutputFormat({
      type: "json_schema",
      json_schema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
    expect(out?.type).toBe("json_schema");
    const schema = out?.schema as Record<string, Record<string, unknown>>;
    expect(schema.properties?.ok).toBeDefined();
  });

  it("treats a json_schema object with no 'schema' key as the schema itself", () => {
    // No nested { schema } key → the whole json_schema object is used as the schema.
    const out = responseFormatToOutputFormat({
      type: "json_schema",
      json_schema: { name: "x" },
    });
    expect(out).toEqual({ type: "json_schema", schema: { name: "x" } });
  });

  it("returns undefined when the json_schema field is entirely absent", () => {
    // rawSchema undefined → schema undefined → undefined.
    expect(responseFormatToOutputFormat({ type: "json_schema" })).toBeUndefined();
  });
});
