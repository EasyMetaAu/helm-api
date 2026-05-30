import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type {
  HelmConfig,
  HelmConfigSchema,
  ProviderConfig,
  ProviderConfigSchema,
} from "./schema.js";

describe("config schema types are z.infer", () => {
  it("HelmConfig equals z.infer<typeof HelmConfigSchema>", () => {
    expectTypeOf<HelmConfig>().toEqualTypeOf<z.infer<typeof HelmConfigSchema>>();
  });
  it("ProviderConfig equals z.infer<typeof ProviderConfigSchema>", () => {
    expectTypeOf<ProviderConfig>().toEqualTypeOf<z.infer<typeof ProviderConfigSchema>>();
  });
});
