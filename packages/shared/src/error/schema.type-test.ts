import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { ErrorClass, ErrorClassSchema, HelmError, HelmErrorSchema } from "./schema.js";

describe("error schema types are z.infer", () => {
  it("HelmError equals z.infer<typeof HelmErrorSchema>", () => {
    expectTypeOf<HelmError>().toEqualTypeOf<z.infer<typeof HelmErrorSchema>>();
  });
  it("ErrorClass equals z.infer<typeof ErrorClassSchema>", () => {
    expectTypeOf<ErrorClass>().toEqualTypeOf<z.infer<typeof ErrorClassSchema>>();
  });
});
