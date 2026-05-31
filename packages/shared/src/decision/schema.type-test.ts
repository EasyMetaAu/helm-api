import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type {
  DecisionRecord,
  DecisionRecordSchema,
  ProviderAttempt,
  ProviderAttemptSchema,
} from "./schema.js";

describe("decision schema types are z.infer", () => {
  it("DecisionRecord equals z.infer<typeof DecisionRecordSchema>", () => {
    expectTypeOf<DecisionRecord>().toEqualTypeOf<z.infer<typeof DecisionRecordSchema>>();
  });
  it("ProviderAttempt equals z.infer<typeof ProviderAttemptSchema>", () => {
    expectTypeOf<ProviderAttempt>().toEqualTypeOf<z.infer<typeof ProviderAttemptSchema>>();
  });
});
