import { describe, expect, it } from "vitest";
import { MemoryJobEnqueueInputSchema, MemoryJobRowSchema, MemoryJobTypeSchema } from "./jobs.js";

// docs/12 P5 — the decay sweep extends the job-type enum with 'decay'. Asserting the
// enum directly (not just via the input schema) pins the rollout-row requirement.
describe("MemoryJobTypeSchema", () => {
  it("parses 'decay' (P5 sweep job kind)", () => {
    expect(MemoryJobTypeSchema.parse("decay")).toBe("decay");
  });

  // docs/14 — hybrid fact retrieval (P8) needs facts embedded off the hot path; the
  // 'embedding' job kind backfills `memory_facts.embedding` for newly inserted facts.
  it("parses 'embedding' (docs/14 fact-embedding job kind)", () => {
    expect(MemoryJobTypeSchema.parse("embedding")).toBe("embedding");
  });

  it("still parses the pre-existing observer / reflector kinds", () => {
    expect(MemoryJobTypeSchema.parse("observer")).toBe("observer");
    expect(MemoryJobTypeSchema.parse("reflector")).toBe("reflector");
  });
});

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

  // docs/12 P5 — the background decay sweep is a THIRD job kind. Its scope is the
  // account being swept (account-only ReflectionScope), so the dedupe index keys it
  // to one open decay row per account.
  it("accepts a decay job with an account-only scope", () => {
    const input = { type: "decay" as const, scope: { accountId: "acct-a" } };
    expect(MemoryJobEnqueueInputSchema.parse(input)).toEqual(input);
  });
});

describe("MemoryJobRowSchema", () => {
  it("round-trips a claimed observer row", () => {
    const row = {
      jobId: "job-1",
      leaseGeneration: 3,
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
