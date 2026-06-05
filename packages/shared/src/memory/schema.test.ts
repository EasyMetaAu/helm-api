import { describe, expect, it } from "vitest";
import {
  FactSchema,
  MemoryFactInputSchema,
  ObservationSchema,
  ReflectionSchema,
} from "./schema.js";

// docs/12 "Schema deltas" (P2): the forgetting columns are additive,
// optional-with-default, so OLD rows persisted before the migration still parse
// — the regression guard CLAUDE.md demands (existing observe/reflect rows must
// stay valid). The new FactSchema / MemoryFactInputSchema model the long-tier
// memory_facts table; ownerId is REQUIRED on input (= accountId, never
// client-supplied) per the "Tenant isolation" section.

describe("ObservationSchema — forgetting deltas backfill on legacy rows", () => {
  // An observation row as written by the docs/08 store BEFORE the v18 migration:
  // no reference_count / importance / status / archived_at / expired_at.
  const legacyRow = {
    id: "obs-1",
    threadId: "t1",
    sourceMessageRange: ["m1", "m2"] as [string, string],
    observationText: "user prefers dark mode",
    observedAt: new Date("2026-06-01T00:00:00.000Z"),
    priority: 2,
    tags: ["pref"],
  };

  it("parses a legacy observation row and backfills forgetting defaults", () => {
    const parsed = ObservationSchema.parse(legacyRow);
    // The new fields must be present with the docs/12 defaults so the score fn
    // (P0) and sweep (P5) can read them off any row, legacy or fresh.
    expect(parsed.referenceCount).toBe(0);
    expect(parsed.importance).toBe(0.5);
    expect(parsed.status).toBe("active");
    // referenced_at starts null (never reinforced); archived/expired null too —
    // the per-tier coalesce fallback makes null mean "age from observed_at".
    expect(parsed.referencedAt).toBeNull();
    expect(parsed.archivedAt).toBeNull();
    expect(parsed.expiredAt).toBeNull();
    // Pre-existing fields are untouched.
    expect(parsed.observationText).toBe("user prefers dark mode");
    expect(parsed.observedAt).toEqual(legacyRow.observedAt);
  });

  it("accepts explicit forgetting values when a fresh row supplies them", () => {
    const parsed = ObservationSchema.parse({
      ...legacyRow,
      referenceCount: 3,
      importance: 0.9,
      status: "archived",
      referencedAt: new Date("2026-06-02T00:00:00.000Z"),
      archivedAt: new Date("2026-06-03T00:00:00.000Z"),
      expiredAt: null,
    });
    expect(parsed.referenceCount).toBe(3);
    expect(parsed.importance).toBe(0.9);
    expect(parsed.status).toBe("archived");
    expect(parsed.referencedAt).toEqual(new Date("2026-06-02T00:00:00.000Z"));
    expect(parsed.archivedAt).toEqual(new Date("2026-06-03T00:00:00.000Z"));
  });
});

describe("ReflectionSchema — forgetting deltas backfill on legacy rows", () => {
  const legacyRow = {
    id: "ref-1",
    projectId: "p1",
    resourceId: null,
    threadId: null,
    reflectionText: "stable summary",
    version: 2,
    tokenEstimate: 10,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  };

  it("parses a legacy reflection row and backfills referenceCount/status", () => {
    const parsed = ReflectionSchema.parse(legacyRow);
    expect(parsed.referenceCount).toBe(0);
    expect(parsed.status).toBe("active");
    expect(parsed.referencedAt).toBeNull();
    expect(parsed.version).toBe(2);
    expect(parsed.reflectionText).toBe("stable summary");
  });
});

describe("FactSchema / MemoryFactInputSchema (memory_facts long tier)", () => {
  it("round-trips a fully populated fact row", () => {
    const row = {
      id: "fact-1",
      ownerId: "acct-a",
      projectId: "p1",
      resourceId: null,
      threadId: null,
      subjectKey: "pref:editor-theme",
      factText: "user prefers dark mode",
      contentHash: "a".repeat(64),
      importance: 0.7,
      referenceCount: 2,
      referencedAt: new Date("2026-06-02T00:00:00.000Z"),
      validFrom: new Date("2026-06-01T00:00:00.000Z"),
      invalidAt: null,
      expiredAt: null,
      status: "active",
      sourceObservationRange: ["obs-1", "obs-9"] as [string, string],
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const parsed = FactSchema.parse(row);
    expect(parsed).toEqual(row);
  });

  it("backfills status/referenceCount/importance defaults + nullable temporals", () => {
    const parsed = FactSchema.parse({
      id: "fact-2",
      ownerId: "acct-a",
      projectId: null,
      resourceId: null,
      threadId: null,
      subjectKey: "topic",
      factText: "fact body",
      contentHash: "b".repeat(64),
      validFrom: new Date("2026-06-01T00:00:00.000Z"),
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(parsed.importance).toBe(0.5);
    expect(parsed.referenceCount).toBe(0);
    expect(parsed.status).toBe("active");
    expect(parsed.referencedAt).toBeNull();
    expect(parsed.invalidAt).toBeNull();
    expect(parsed.expiredAt).toBeNull();
    expect(parsed.sourceObservationRange).toBeUndefined();
  });

  it("requires ownerId on the write input (never client-supplied)", () => {
    const base = {
      subjectKey: "topic",
      factText: "fact body",
      contentHash: "c".repeat(64),
      validFrom: new Date("2026-06-01T00:00:00.000Z"),
    };
    // Missing ownerId fails-closed — every fact write is account-scoped.
    expect(() => MemoryFactInputSchema.parse(base)).toThrow();
    const ok = MemoryFactInputSchema.parse({ ...base, ownerId: "acct-a" });
    expect(ok.ownerId).toBe("acct-a");
    // Defaults mirror the read schema so an input round-trips into a row.
    expect(ok.importance).toBe(0.5);
    expect(ok.status).toBe("active");
  });
});
