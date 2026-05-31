import { describe, expect, it } from "vitest";
import { parseEvalOutput } from "./contract.js";

// eval.contract — `parseEvalOutput` is the fail-open parser for the Layer-2
// small-model output. The model output is UNTRUSTED external input: it may be
// wrapped in a ```json fence, may have missing/extra fields, may carry an
// unknown enum, or may not be JSON at all. The parser NEVER throws — on any
// validation failure it returns `{ ok:false, reason }` so eval.cascade can
// fail-open to balanced (CLAUDE.md principle 3). It does NOT normalize/lowercase
// — enums must match exactly so model drift surfaces rather than being masked.

describe("parseEvalOutput", () => {
  it("parses a valid strict-JSON object (test 1)", () => {
    const raw = '{"complexity":"complex","task_type":"coding","confidence":0.82}';
    const result = parseEvalOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        complexity: "complex",
        task_type: "coding",
        confidence: 0.82,
      });
    }
  });

  it("strips a ```json code fence and still parses (test 2)", () => {
    const raw = [
      "```json",
      '{"complexity":"standard","task_type":"chat","confidence":0.7}',
      "```",
    ].join("\n");
    const result = parseEvalOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complexity).toBe("standard");
      expect(result.value.task_type).toBe("chat");
    }
  });

  it("strips leading prose before the first {...} (test 2b)", () => {
    const raw =
      'Sure, here is my judgment:\n{"complexity":"simple","task_type":"chat","confidence":0.9} hope it helps';
    const result = parseEvalOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complexity).toBe("simple");
    }
  });

  it("fails open on an invalid task_type enum without throwing (test 3)", () => {
    const raw = '{"complexity":"complex","task_type":"banana","confidence":0.82}';
    const result = parseEvalOutput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_invalid");
      expect(result.raw).toBe(raw);
    }
  });

  it("fails open when a required field is missing (test 4)", () => {
    const raw = '{"complexity":"complex","task_type":"coding"}';
    const result = parseEvalOutput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_invalid");
    }
  });

  it("fails open on extra fields via .strict() (test 5)", () => {
    const raw = '{"complexity":"complex","task_type":"coding","confidence":0.82,"note":"because"}';
    const result = parseEvalOutput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_invalid");
    }
  });

  it("reports not_json for plain prose (test 6)", () => {
    const raw = "I think this is complex.";
    const result = parseEvalOutput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_json");
      expect(result.raw).toBe(raw);
    }
  });

  it("fails open on out-of-range confidence without clamping (test 7)", () => {
    const raw = '{"complexity":"complex","task_type":"coding","confidence":1.4}';
    const result = parseEvalOutput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_invalid");
    }
  });

  it("never throws on adversarial inputs (test 8)", () => {
    const adversarial = [
      "",
      "   ",
      "null",
      "undefined",
      "[]",
      "{",
      '{"complexity":"complex","task_type":"coding","confidence":', // truncated
      "{}",
      "true",
      "42",
      '"a string"',
      "{not json at all",
      // deeply nested noise
      'prefix {"complexity":"reasoning","task_type":"math","confidence":0.5} {"extra":1}',
    ];
    for (const input of adversarial) {
      expect(() => parseEvalOutput(input)).not.toThrow();
      const result = parseEvalOutput(input);
      // discriminated union — always has an `ok` boolean
      expect(typeof result.ok).toBe("boolean");
    }
  });

  it("accepts confidence at the exact bounds 0 and 1 (boundary)", () => {
    const low = parseEvalOutput('{"complexity":"simple","task_type":"chat","confidence":0}');
    const high = parseEvalOutput('{"complexity":"reasoning","task_type":"math","confidence":1}');
    expect(low.ok).toBe(true);
    expect(high.ok).toBe(true);
  });
});
