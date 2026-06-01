import type { Lane, PoliciesConfig } from "@helm/core";
import type { ClassifierConfig } from "@helm/shared";
import type { RuleStore } from "./deps.js";

// Runtime (in-process) RuleStore — the MVP backing for the admin rule-config
// endpoints. The task explicitly permits "config/*.yaml or a runtime ConfigStore";
// this is the latter: edits update the live in-memory config the router reads, so
// changes take effect without a restart. Per CLAUDE.md Principle 2 the canonical persistence target is
// still the rule config (NOT the DB). A future YAML write-back adapter can replace
// this without touching the routes (they depend only on the RuleStore interface).
//
// `onChange` callbacks let the caller re-bind the live routing closures (lanes /
// policies / classifier) so an admin edit is observed by subsequent requests.
export interface RuntimeRuleStoreInit {
  lanes: Record<string, Lane>;
  policies: PoliciesConfig;
  classifier: ClassifierConfig;
  onLanes?: (lanes: Record<string, Lane>) => void;
  onPolicies?: (policies: PoliciesConfig) => void;
  onClassifier?: (cfg: ClassifierConfig) => void;
}

export function createRuntimeRuleStore(init: RuntimeRuleStoreInit): RuleStore {
  let lanes = init.lanes;
  let policies = init.policies;
  let classifier = init.classifier;
  return {
    getLanes: async () => lanes,
    setLanes: async (next) => {
      lanes = next;
      init.onLanes?.(next);
    },
    getPolicies: async () => policies,
    setPolicies: async (next) => {
      policies = next;
      init.onPolicies?.(next);
    },
    getClassifier: async () => classifier,
    setClassifier: async (next) => {
      classifier = next;
      init.onClassifier?.(next);
    },
  };
}
