import { describe, expect, it } from "vitest";
import { type PoliciesConfig, PoliciesConfigSchema, parsePoliciesConfig } from "./policy-schema.js";

describe("policy-schema", () => {
  it("accepts an empty policies array", () => {
    const cfg = parsePoliciesConfig({ policies: [] });
    expect(cfg.policies).toEqual([]);
  });

  it("defaults policies to [] when key omitted", () => {
    const cfg = parsePoliciesConfig({});
    expect(cfg.policies).toEqual([]);
  });

  it("parses a policy with use_lane", () => {
    const cfg = parsePoliciesConfig({
      policies: [{ id: "p1", match: { task_type: "coding" }, use_lane: "coding" }],
    });
    expect(cfg.policies[0]?.use_lane).toBe("coding");
  });

  it("fail-closed: a policy with no action field (use_lane/max_lane/allowed_lanes) throws", () => {
    expect(() => parsePoliciesConfig({ policies: [{ match: { task_type: "coding" } }] })).toThrow();
  });

  it("fail-closed: unknown field in policy (.strict) throws", () => {
    expect(() =>
      parsePoliciesConfig({
        policies: [{ match: { task_type: "coding" }, use_lane: "coding", bogus: 1 }],
      }),
    ).toThrow();
  });

  it("fail-closed: unknown field in match (.strict) throws", () => {
    expect(() =>
      parsePoliciesConfig({
        policies: [{ match: { task_type: "coding", bogus: true }, use_lane: "coding" }],
      }),
    ).toThrow();
  });

  it("fail-closed: unknown top-level field (.strict) throws", () => {
    expect(() => parsePoliciesConfig({ policies: [], extra: true })).toThrow();
  });

  it("fail-closed: invalid complexity enum throws", () => {
    expect(() =>
      parsePoliciesConfig({
        policies: [{ match: { complexity: "huge" }, use_lane: "premium" }],
      }),
    ).toThrow();
  });

  it("accepts caps-only policy (max_lane / allowed_lanes without use_lane)", () => {
    const cfg = parsePoliciesConfig({
      policies: [
        { match: { org_id: "low_cost_org" }, max_lane: "balanced" },
        { match: { org_id: "white_list_org" }, allowed_lanes: ["economy", "balanced"] },
      ],
    });
    expect(cfg.policies[0]?.max_lane).toBe("balanced");
    expect(cfg.policies[1]?.allowed_lanes).toEqual(["economy", "balanced"]);
  });

  it("exposes inferred PoliciesConfig type via schema (compile-time)", () => {
    const cfg: PoliciesConfig = PoliciesConfigSchema.parse({ policies: [] });
    expect(cfg.policies).toEqual([]);
  });
});
