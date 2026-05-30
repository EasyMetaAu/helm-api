import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { InternalRequest, InternalRequestSchema, Protocol, ProtocolSchema } from "./schema.js";

// Type-level assertions: the exported types ARE the inferred schema types, so
// there is no second hand-written definition that could drift.
describe("request schema types are z.infer", () => {
  it("InternalRequest equals z.infer<typeof InternalRequestSchema>", () => {
    expectTypeOf<InternalRequest>().toEqualTypeOf<z.infer<typeof InternalRequestSchema>>();
  });
  it("Protocol equals z.infer<typeof ProtocolSchema>", () => {
    expectTypeOf<Protocol>().toEqualTypeOf<z.infer<typeof ProtocolSchema>>();
  });
});
