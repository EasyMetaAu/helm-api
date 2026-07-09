import { describe, expect, it } from "vitest";
import { factMatchesStatus } from "./fact-status";

// The bug: an unguarded `status === filter` fallback let superseded facts
// (status:"active", superseded:true) pass the Active filter, because their
// status is still "active". Guard against that regression here.
const active = { status: "active" as const, superseded: false };
const superseded = { status: "active" as const, superseded: true };
const archived = { status: "archived" as const, superseded: false };
const pruned = { status: "pruned" as const, superseded: false };

describe("factMatchesStatus", () => {
  it("Active excludes superseded facts", () => {
    expect(factMatchesStatus(active, "active")).toBe(true);
    expect(factMatchesStatus(superseded, "active")).toBe(false); // the fix
    expect(factMatchesStatus(archived, "active")).toBe(false);
    expect(factMatchesStatus(pruned, "active")).toBe(false);
  });

  it("Superseded shows only superseded facts", () => {
    expect(factMatchesStatus(superseded, "superseded")).toBe(true);
    expect(factMatchesStatus(active, "superseded")).toBe(false);
    expect(factMatchesStatus(archived, "superseded")).toBe(false);
  });

  it("archived/pruned match on status alone", () => {
    expect(factMatchesStatus(archived, "archived")).toBe(true);
    expect(factMatchesStatus(pruned, "pruned")).toBe(true);
    expect(factMatchesStatus(active, "archived")).toBe(false);
    expect(factMatchesStatus(superseded, "pruned")).toBe(false);
  });

  it("all matches everything", () => {
    for (const f of [active, superseded, archived, pruned]) {
      expect(factMatchesStatus(f, "all")).toBe(true);
    }
  });
});
