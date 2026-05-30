import { describe, expect, it } from "vitest";
import { applyCaps, evaluatePolicies, LANE_RANK, type PolicyContext } from "./policy-engine.js";
import type { PoliciesConfig } from "./policy-schema.js";

const baseCtx: PolicyContext = {
  task_type: "coding",
  complexity: "complex",
  needs_json: false,
  needs_tools: false,
  needs_vision: false,
  user_id: null,
  org_id: null,
  project_id: null,
};

function cfg(policies: PoliciesConfig["policies"]): PoliciesConfig {
  return { policies };
}

describe("evaluatePolicies — first-match", () => {
  it("returns the FIRST matching policy and ignores later matches", () => {
    const c = cfg([
      { id: "first", match: { task_type: "coding" }, use_lane: "coding" },
      { id: "second", match: { task_type: "coding" }, use_lane: "premium" },
    ]);
    const out = evaluatePolicies(baseCtx, c);
    expect(out.matched_policy_id).toBe("first");
    expect(out.use_lane).toBe("coding");
  });

  it("returns all-null outcome when nothing matches", () => {
    const c = cfg([{ id: "p", match: { task_type: "writing" }, use_lane: "balanced" }]);
    const out = evaluatePolicies(baseCtx, c);
    expect(out.matched_policy_id).toBeNull();
    expect(out.use_lane).toBeNull();
    expect(out.max_lane).toBeNull();
    expect(out.allowed_lanes).toBeNull();
  });

  it("returns all-null outcome on empty policy list", () => {
    const out = evaluatePolicies(baseCtx, cfg([]));
    expect(out.matched_policy_id).toBeNull();
  });
});

describe("evaluatePolicies — AND semantics", () => {
  it("does NOT match when one declared field differs", () => {
    const ctx: PolicyContext = { ...baseCtx, complexity: "medium" };
    const c = cfg([
      {
        id: "and",
        match: { task_type: "coding", complexity: "complex" },
        use_lane: "coding",
      },
    ]);
    expect(evaluatePolicies(ctx, c).matched_policy_id).toBeNull();
  });

  it("matches when all declared fields equal (unwritten fields unconstrained)", () => {
    const c = cfg([
      {
        id: "and",
        match: { task_type: "coding", complexity: "complex" },
        use_lane: "coding",
      },
    ]);
    expect(evaluatePolicies(baseCtx, c).matched_policy_id).toBe("and");
  });

  it("boolean fields require strict equality", () => {
    const c = cfg([{ id: "j", match: { needs_json: true }, use_lane: "premium" }]);
    expect(evaluatePolicies(baseCtx, c).matched_policy_id).toBeNull();
    const ctx: PolicyContext = { ...baseCtx, needs_json: true };
    expect(evaluatePolicies(ctx, c).matched_policy_id).toBe("j");
  });
});

describe("evaluatePolicies — identity dimensions", () => {
  it("matches on user_id and surfaces use_lane", () => {
    const ctx: PolicyContext = { ...baseCtx, user_id: "vip_user" };
    const c = cfg([{ id: "vip", match: { user_id: "vip_user" }, use_lane: "premium" }]);
    const out = evaluatePolicies(ctx, c);
    expect(out.matched_policy_id).toBe("vip");
    expect(out.use_lane).toBe("premium");
  });

  it("does not match a different user_id", () => {
    const ctx: PolicyContext = { ...baseCtx, user_id: "other" };
    const c = cfg([{ id: "vip", match: { user_id: "vip_user" }, use_lane: "premium" }]);
    expect(evaluatePolicies(ctx, c).matched_policy_id).toBeNull();
  });
});

describe("evaluatePolicies — telemetry / determinism", () => {
  it("synthesizes a policy id from index when id omitted", () => {
    const c = cfg([{ match: { task_type: "coding" }, use_lane: "coding" }]);
    expect(evaluatePolicies(baseCtx, c).matched_policy_id).toBe("policy[0]");
  });

  it("reason mentions the matched id and a triggering field", () => {
    const c = cfg([{ id: "vip", match: { user_id: "x" }, use_lane: "premium" }]);
    const ctx: PolicyContext = { ...baseCtx, user_id: "x" };
    const out = evaluatePolicies(ctx, c);
    expect(out.reason).toContain("vip");
    expect(out.reason).toContain("user_id");
  });

  it("is deterministic across repeated calls", () => {
    const c = cfg([
      { id: "first", match: { task_type: "coding" }, use_lane: "coding" },
      { id: "second", match: { task_type: "coding" }, use_lane: "premium" },
    ]);
    const a = evaluatePolicies(baseCtx, c);
    const b = evaluatePolicies(baseCtx, c);
    expect(a).toEqual(b);
  });
});

describe("applyCaps — max_lane", () => {
  const outcome = {
    matched_policy_id: "p",
    use_lane: null,
    max_lane: "balanced",
    allowed_lanes: null,
    reason: "",
  };

  it("caps a higher lane down to max_lane", () => {
    expect(applyCaps("premium", outcome)).toBe("balanced");
  });

  it("leaves a lane already at/below max_lane untouched (no upgrade)", () => {
    expect(applyCaps("economy", outcome)).toBe("economy");
    expect(applyCaps("balanced", outcome)).toBe("balanced");
  });

  it("conservatively caps an unrankable candidate lane down to max_lane", () => {
    // task lane like `coding` is not in LANE_RANK -> incomparable -> cap to max_lane
    expect(applyCaps("coding", outcome)).toBe("balanced");
  });
});

describe("applyCaps — allowed_lanes", () => {
  const outcome = {
    matched_policy_id: "p",
    use_lane: null,
    max_lane: null,
    allowed_lanes: ["economy", "balanced"],
    reason: "",
  };

  it("converges an out-of-list higher lane to the highest allowed <= candidate", () => {
    expect(applyCaps("premium", outcome)).toBe("balanced");
  });

  it("leaves an in-list lane untouched", () => {
    expect(applyCaps("balanced", outcome)).toBe("balanced");
    expect(applyCaps("economy", outcome)).toBe("economy");
  });

  it("falls back to the lowest-ranked allowed lane when no allowed lane is <= candidate", () => {
    const out = {
      matched_policy_id: "p",
      use_lane: null,
      max_lane: null,
      allowed_lanes: ["balanced", "premium"],
      reason: "",
    };
    // candidate economy is below all allowed -> lowest allowed = balanced
    expect(applyCaps("economy", out)).toBe("balanced");
  });
});

describe("applyCaps — no caps", () => {
  it("returns the candidate unchanged when outcome has no caps", () => {
    const out = {
      matched_policy_id: null,
      use_lane: null,
      max_lane: null,
      allowed_lanes: null,
      reason: "",
    };
    expect(applyCaps("premium", out)).toBe("premium");
  });
});

describe("LANE_RANK", () => {
  it("orders economy < balanced < premium", () => {
    expect(LANE_RANK.economy).toBeLessThan(LANE_RANK.balanced ?? 0);
    expect(LANE_RANK.balanced).toBeLessThan(LANE_RANK.premium ?? 0);
  });
});
