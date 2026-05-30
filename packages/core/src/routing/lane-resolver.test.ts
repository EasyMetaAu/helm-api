import { describe, expect, it } from "vitest";
import type { LanesConfig } from "../lanes/schema.js";
import {
  type Classification,
  type PolicyOutcome,
  type ResolveLaneInput,
  resolveLane,
} from "./lane-resolver.js";

// Minimal valid lane shape; resolver only inspects key existence, never the body.
function lane(): LanesConfig[string] {
  return { primary: "m", fallback: [], constraints: {} as never } as LanesConfig[string];
}

// Lanes config builder: `balanced` is guaranteed present by lanes.schema, so the
// resolver's terminal is always valid. Tests opt into extra lanes explicitly.
function lanes(names: string[]): LanesConfig {
  const out: Record<string, LanesConfig[string]> = { balanced: lane() };
  for (const n of names) out[n] = lane();
  return out as LanesConfig;
}

function classification(over: Partial<Classification> = {}): Classification {
  return {
    task_type: "coding",
    complexity: "complex",
    decided_by: "rules",
    constraints: {},
    ...over,
  };
}

const NO_POLICY: PolicyOutcome = {
  matched_policy_id: null,
  use_lane: null,
  reason: "no policy matched",
};

function input(over: Partial<ResolveLaneInput> = {}): ResolveLaneInput {
  return {
    classification: classification(),
    policy: NO_POLICY,
    lanes: lanes(["coding", "economy", "premium"]),
    ...over,
  };
}

describe("resolveLane — priority order", () => {
  it("policy.use_lane wins over a matching task lane (decided_by=policy)", () => {
    const out = resolveLane(
      input({
        policy: { matched_policy_id: "p", use_lane: "premium", reason: "policy 'p'" },
        classification: classification({ task_type: "coding" }),
      }),
    );
    expect(out.selected_lane).toBe("premium");
    expect(out.decided_by).toBe("policy");
  });

  it("falls to task lane when policy has no use_lane (decided_by=task_lane)", () => {
    const out = resolveLane(
      input({ policy: NO_POLICY, classification: classification({ task_type: "coding" }) }),
    );
    expect(out.selected_lane).toBe("coding");
    expect(out.decided_by).toBe("task_lane");
  });
});

describe("resolveLane — complexity fallback", () => {
  it("maps complex -> premium when no policy and no task lane", () => {
    const out = resolveLane(
      input({
        lanes: lanes(["economy", "premium"]), // no `coding` lane
        classification: classification({ task_type: "coding", complexity: "complex" }),
      }),
    );
    expect(out.selected_lane).toBe("premium");
    expect(out.decided_by).toBe("complexity_fallback");
  });

  it("maps simple -> economy", () => {
    const out = resolveLane(
      input({
        lanes: lanes(["economy", "premium"]),
        classification: classification({ task_type: "writing", complexity: "simple" }),
      }),
    );
    expect(out.selected_lane).toBe("economy");
    expect(out.decided_by).toBe("complexity_fallback");
  });

  it("maps medium -> balanced", () => {
    const out = resolveLane(
      input({
        lanes: lanes(["economy", "premium"]),
        classification: classification({ task_type: "writing", complexity: "medium" }),
      }),
    );
    expect(out.selected_lane).toBe("balanced");
    expect(out.decided_by).toBe("complexity_fallback");
  });
});

describe("resolveLane — fail-open to balanced", () => {
  it("falls to balanced when nothing else resolves (only balanced configured)", () => {
    const out = resolveLane(
      input({
        lanes: lanes([]), // only `balanced`
        classification: classification({ task_type: "coding", complexity: "complex" }),
      }),
    );
    expect(out.selected_lane).toBe("balanced");
  });

  it("classifier self-fallback (decided_by=default) goes straight to balanced", () => {
    const out = resolveLane(
      input({
        // coding lane exists & complexity=complex maps to premium, but the
        // classifier already fell back, so resolver must short-circuit to balanced.
        lanes: lanes(["coding", "economy", "premium"]),
        classification: classification({
          task_type: "coding",
          complexity: "complex",
          decided_by: "default",
        }),
      }),
    );
    expect(out.selected_lane).toBe("balanced");
  });

  it("policy pointing at a non-existent lane does not throw; falls through to balanced", () => {
    const out = resolveLane(
      input({
        policy: { matched_policy_id: "p", use_lane: "ghost", reason: "policy 'p'" },
        lanes: lanes([]), // only `balanced`; no ghost, no coding
        classification: classification({ task_type: "ghosttask", complexity: "complex" }),
      }),
    );
    expect(out.selected_lane).toBe("balanced");
    expect(out.reason.toLowerCase()).toContain("balanced");
  });

  it("policy pointing at a non-existent lane still defers to a valid task lane", () => {
    const out = resolveLane(
      input({
        policy: { matched_policy_id: "p", use_lane: "ghost", reason: "policy 'p'" },
        lanes: lanes(["coding", "economy", "premium"]),
        classification: classification({ task_type: "coding", complexity: "complex" }),
      }),
    );
    // ghost is missing -> not policy; coding lane exists -> task_lane.
    expect(out.selected_lane).toBe("coding");
    expect(out.decided_by).toBe("task_lane");
  });
});

describe("resolveLane — determinism / purity", () => {
  it("returns an identical result for identical input across calls", () => {
    const i = input();
    expect(resolveLane(i)).toEqual(resolveLane(i));
  });

  it("does not mutate its input", () => {
    const i = input();
    const snapshot = JSON.stringify(i);
    resolveLane(i);
    expect(JSON.stringify(i)).toBe(snapshot);
  });
});
