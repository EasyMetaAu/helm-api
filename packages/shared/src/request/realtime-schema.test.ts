import { describe, expect, it } from "vitest";
import { RealtimeSessionSchema } from "./realtime-schema.js";

describe("RealtimeSessionSchema", () => {
  it("keeps provider-specific session fields while requiring a model", () => {
    const parsed = RealtimeSessionSchema.parse({
      model: "gpt-realtime-1.5",
      type: "quicksilver",
      audio: { output: { voice: "cove" } },
    });
    expect(parsed.audio).toEqual({ output: { voice: "cove" } });
  });

  it("rejects a session without a model", () => {
    expect(RealtimeSessionSchema.safeParse({ type: "quicksilver" }).success).toBe(false);
  });
});
