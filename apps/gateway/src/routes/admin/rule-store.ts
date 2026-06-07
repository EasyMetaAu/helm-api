import type { Lane, PoliciesConfig } from "@helm/core";
import type { ClassifierConfig } from "@helm/shared";
import type { RuleStore } from "./deps.js";

// Runtime RuleStore backing the admin rule-config endpoints. Edits update the
// live in-memory config the router reads (no restart), and — when the optional
// `persist*` hooks are wired (yaml-writeback.ts) — are FIRST written back to the
// canonical config/*.yaml (CLAUDE.md Principle 2: the file, not the DB, is the
// persistence target). Ordering is FAIL-CLOSED: persist BEFORE rebind, so a
// failed write rejects the set* call with the live config (and onChange
// listeners) untouched — file and memory never diverge, and a restart re-loads
// exactly what the operator last saved.
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
  // Optional write-back to the canonical yaml files. Throwing aborts the edit.
  persistLanes?: (lanes: Record<string, Lane>) => Promise<void>;
  persistPolicies?: (policies: PoliciesConfig) => Promise<void>;
  persistClassifier?: (cfg: ClassifierConfig) => Promise<void>;
}

export function createRuntimeRuleStore(init: RuntimeRuleStoreInit): RuleStore {
  let lanes = init.lanes;
  let policies = init.policies;
  let classifier = init.classifier;
  return {
    getLanes: async () => lanes,
    setLanes: async (next) => {
      await init.persistLanes?.(next);
      lanes = next;
      init.onLanes?.(next);
    },
    getPolicies: async () => policies,
    setPolicies: async (next) => {
      await init.persistPolicies?.(next);
      policies = next;
      init.onPolicies?.(next);
    },
    getClassifier: async () => classifier,
    setClassifier: async (next) => {
      await init.persistClassifier?.(next);
      classifier = next;
      init.onClassifier?.(next);
    },
  };
}
