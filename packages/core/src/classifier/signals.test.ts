import { describe, expect, it } from "vitest";
import { nonLatinRatio } from "./signals.js";

// nonLatinRatio measures the fraction of *letters* (\p{L}) that are NOT Latin
// script. It feeds the Layer-1 language-coverage guard (engine.ts): Layer-1 has
// English plus small high-confidence international keyword lists, so non-covered
// languages and prompts that miss those lists must be marked uncertain → escalate to the
// (multilingual) Layer-2 eval. Punctuation, digits and whitespace are NOT letters,
// so they never skew the ratio. Pure: same input => same output.
describe("nonLatinRatio", () => {
  it("is 0 for pure English/Latin prose", () => {
    expect(nonLatinRatio("please analyze this company's financials")).toBe(0);
  });

  it("is ~1 for pure Chinese prose", () => {
    expect(nonLatinRatio("请帮我分析这家公司的财务状况")).toBeGreaterThan(0.95);
  });

  it("is ~1 for Japanese / Korean prose", () => {
    expect(nonLatinRatio("この関数を実装してください")).toBeGreaterThan(0.95);
    expect(nonLatinRatio("이 회사를 분석해 주세요")).toBeGreaterThan(0.95);
  });

  it("is fractional for mixed-script text", () => {
    // "analyze 这家 company" → 7+7 Latin letters, 2 Han letters → 2/16
    const r = nonLatinRatio("analyze 这家 company");
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(0.5);
  });

  it("is 0 when there are no letters (digits / punctuation / whitespace only)", () => {
    expect(nonLatinRatio("12345 !!! ... \n\t")).toBe(0);
    expect(nonLatinRatio("")).toBe(0);
  });

  it("ignores non-letter characters when computing the ratio", () => {
    // Digits, spaces and punctuation are excluded; only the Han letters count → ~1.
    expect(nonLatinRatio("分析：2024年第三季度报告")).toBeGreaterThan(0.95);
  });
});
