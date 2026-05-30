import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type {
  IRMessage,
  IRMessageSchema,
  IRRequest,
  IRRequestSchema,
  IRResponse,
  IRResponseSchema,
} from "./ir.js";

// Type-level assertions: the exported IR types ARE z.infer of their schemas —
// no second hand-written definition that could drift (CLAUDE.md: Zod schema is
// the single source of truth).
describe("IR types are z.infer of their schemas", () => {
  it("IRRequest equals z.infer<typeof IRRequestSchema>", () => {
    expectTypeOf<IRRequest>().toEqualTypeOf<z.infer<typeof IRRequestSchema>>();
  });
  it("IRResponse equals z.infer<typeof IRResponseSchema>", () => {
    expectTypeOf<IRResponse>().toEqualTypeOf<z.infer<typeof IRResponseSchema>>();
  });
  it("IRMessage equals z.infer<typeof IRMessageSchema>", () => {
    expectTypeOf<IRMessage>().toEqualTypeOf<z.infer<typeof IRMessageSchema>>();
  });
});
