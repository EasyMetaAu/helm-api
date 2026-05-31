import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type {
  ClassifierConfig,
  ClassifierConfigSchema,
  ClassifierEvalConfig,
  ClassifierEvalConfigSchema,
  ClassifierRulesConfig,
  ClassifierRulesConfigSchema,
  DimensionConfig,
  DimensionConfigSchema,
} from "./classifier-schema.js";

describe("classifier schema types are z.infer (single source of truth)", () => {
  it("ClassifierConfig equals z.infer<typeof ClassifierConfigSchema>", () => {
    expectTypeOf<ClassifierConfig>().toEqualTypeOf<z.infer<typeof ClassifierConfigSchema>>();
  });
  it("ClassifierRulesConfig equals z.infer<typeof ClassifierRulesConfigSchema>", () => {
    expectTypeOf<ClassifierRulesConfig>().toEqualTypeOf<
      z.infer<typeof ClassifierRulesConfigSchema>
    >();
  });
  it("ClassifierEvalConfig equals z.infer<typeof ClassifierEvalConfigSchema>", () => {
    expectTypeOf<ClassifierEvalConfig>().toEqualTypeOf<
      z.infer<typeof ClassifierEvalConfigSchema>
    >();
  });
  it("DimensionConfig equals z.infer<typeof DimensionConfigSchema>", () => {
    expectTypeOf<DimensionConfig>().toEqualTypeOf<z.infer<typeof DimensionConfigSchema>>();
  });
});
