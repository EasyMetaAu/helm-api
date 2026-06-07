import { describe, expect, it, vi } from "vitest";
import { createRuntimeRuleStore } from "./rule-store.js";

// Runtime RuleStore + YAML persistence ordering. The persist hook is the
// fail-closed gate: it runs BEFORE the in-memory rebind, so a YAML write failure
// rejects the set* call and leaves the live config (and onChange listeners)
// untouched — file and memory never diverge (CLAUDE.md principle 2).

const CLASSIFIER_A = { rules: { enabled: true }, eval: { enabled: false } } as never;
const CLASSIFIER_B = { rules: { enabled: true }, eval: { enabled: true } } as never;

describe("createRuntimeRuleStore — persist hooks", () => {
  it("persists BEFORE rebinding, then notifies onChange", async () => {
    const calls: string[] = [];
    const store = createRuntimeRuleStore({
      lanes: {},
      policies: { policies: [] },
      classifier: CLASSIFIER_A,
      persistClassifier: async () => {
        calls.push("persist");
      },
      onClassifier: () => {
        calls.push("rebind");
      },
    });

    await store.setClassifier(CLASSIFIER_B);
    expect(calls).toEqual(["persist", "rebind"]);
    expect(await store.getClassifier()).toBe(CLASSIFIER_B);
  });

  it("a persist failure rejects and leaves the live value + listeners untouched (fail-closed)", async () => {
    const onClassifier = vi.fn();
    const store = createRuntimeRuleStore({
      lanes: {},
      policies: { policies: [] },
      classifier: CLASSIFIER_A,
      persistClassifier: async () => {
        throw new Error("EACCES: read-only config dir");
      },
      onClassifier,
    });

    await expect(store.setClassifier(CLASSIFIER_B)).rejects.toThrow("EACCES");
    expect(await store.getClassifier()).toBe(CLASSIFIER_A); // unchanged
    expect(onClassifier).not.toHaveBeenCalled();
  });

  it("lanes + policies follow the same contract", async () => {
    const persistLanes = vi.fn().mockRejectedValue(new Error("disk full"));
    const persistPolicies = vi.fn().mockResolvedValue(undefined);
    const store = createRuntimeRuleStore({
      lanes: { balanced: { primary: "a/b" } as never },
      policies: { policies: [] },
      classifier: CLASSIFIER_A,
      persistLanes,
      persistPolicies,
    });

    await expect(store.setLanes({} as never)).rejects.toThrow("disk full");
    expect(Object.keys(await store.getLanes())).toEqual(["balanced"]); // unchanged

    const nextPolicies = { policies: [{ match: {}, use_lane: "json" }] } as never;
    await store.setPolicies(nextPolicies);
    expect(persistPolicies).toHaveBeenCalledWith(nextPolicies);
    expect(await store.getPolicies()).toBe(nextPolicies);
  });

  it("without persist hooks behaves exactly as before (in-memory only)", async () => {
    const store = createRuntimeRuleStore({
      lanes: {},
      policies: { policies: [] },
      classifier: CLASSIFIER_A,
    });
    await store.setClassifier(CLASSIFIER_B);
    expect(await store.getClassifier()).toBe(CLASSIFIER_B);
  });
});
