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

  it("parses a policy with standalone reasoning_effort override", () => {
    const cfg = parsePoliciesConfig({
      policies: [{ id: "p1", match: { task_type: "coding" }, reasoning_effort: "low" }],
    });
    expect(cfg.policies[0]?.reasoning_effort).toBe("low");
  });

  it("fail-closed: a policy with no action field (use_lane/allowed_lanes/reasoning_effort) throws", () => {
    expect(() => parsePoliciesConfig({ policies: [{ match: { task_type: "coding" } }] })).toThrow();
  });

  it("fail-closed: unknown policy reasoning_effort value throws", () => {
    expect(() =>
      parsePoliciesConfig({
        policies: [{ match: { task_type: "coding" }, reasoning_effort: "ultra" }],
      }),
    ).toThrow();
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

  it("accepts a restrict-only policy (allowed_lanes without use_lane)", () => {
    const cfg = parsePoliciesConfig({
      policies: [{ match: { complexity: "complex" }, allowed_lanes: ["economy", "balanced"] }],
    });
    expect(cfg.policies[0]?.allowed_lanes).toEqual(["economy", "balanced"]);
  });

  it("fail-closed: the retired policy max_lane cap is rejected (.strict)", () => {
    // max_lane was removed — lanes are parallel, not a strict hierarchy; use
    // allowed_lanes (whitelist) instead. A leftover max_lane fails closed at boot.
    expect(() =>
      parsePoliciesConfig({ policies: [{ match: { task_type: "coding" }, max_lane: "balanced" }] }),
    ).toThrow();
  });

  it("fail-closed: org_id / user_id are not match dimensions (.strict)", () => {
    // Routing has no org/user scope — per-key limits live on the API KEY, not in
    // policies. A leftover org_id/user_id policy must fail boot, never silently
    // match-nothing (review fix #1).
    expect(() =>
      parsePoliciesConfig({ policies: [{ match: { org_id: "acme" }, use_lane: "balanced" }] }),
    ).toThrow();
    expect(() =>
      parsePoliciesConfig({ policies: [{ match: { user_id: "vip" }, use_lane: "premium" }] }),
    ).toThrow();
  });

  it("exposes inferred PoliciesConfig type via schema (compile-time)", () => {
    const cfg: PoliciesConfig = PoliciesConfigSchema.parse({ policies: [] });
    expect(cfg.policies).toEqual([]);
  });
});
