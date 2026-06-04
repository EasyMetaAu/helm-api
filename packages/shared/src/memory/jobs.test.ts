import { describe, expect, it } from "vitest";
import { MemoryJobEnqueueInputSchema, MemoryJobRowSchema } from "./jobs.js";

// docs/08 Phase 2 — the background job queue contracts (single source of truth in
// @helm/shared, types via z.infer). A job carries a type (observer | reflector)
// and a ReflectionScope; a claimed row additionally carries its store-assigned id.

describe("MemoryJobEnqueueInputSchema", () => {
  it("accepts an observer job with a thread scope", () => {
    const parsed = MemoryJobEnqueueInputSchema.parse({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "t1" },
    });
    expect(parsed).toEqual({ type: "observer", scope: { accountId: "acct-a", threadId: "t1" } });
  });

  it("accepts a reflector job with a full scope (round-trip)", () => {
    const input = {
      type: "reflector" as const,
      scope: { accountId: "acct-a", projectId: "p1", resourceId: "r1", threadId: "t1" },
    };
    expect(MemoryJobEnqueueInputSchema.parse(input)).toEqual(input);
  });

  it("rejects an unknown job type", () => {
    expect(() =>
      MemoryJobEnqueueInputSchema.parse({ type: "compactor", scope: { accountId: "acct-a" } }),
    ).toThrow();
  });
});

describe("MemoryJobRowSchema", () => {
  it("round-trips a claimed observer row", () => {
    const row = {
      jobId: "job-1",
      type: "observer" as const,
      scope: { accountId: "acct-a", threadId: "t1" },
    };
    expect(MemoryJobRowSchema.parse(row)).toEqual(row);
  });

  it("rejects a row without a jobId", () => {
    expect(() =>
      MemoryJobRowSchema.parse({ type: "observer", scope: { accountId: "acct-a" } }),
    ).toThrow();
  });
});
