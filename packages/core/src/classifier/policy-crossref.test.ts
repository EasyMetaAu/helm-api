import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LanesConfigSchema, PoliciesConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ALL_TASKS } from "./taskdetect.js";

// CROSS-REFERENCE guard — the highest-value protection for the policy layer.
// policies.yaml is validated in ISOLATION by PoliciesConfigSchema (it
// deliberately does NOT cross-reference lanes.yaml or the task vocabulary —
// policy-schema.ts comment), so two whole classes of "silent dead rule" slip
// past schema validation:
//   1. a `match.task_type` that is NOT in the CLOSED TaskType union (ALL_TASKS):
//      the classifier can never emit it, so the policy can never match — a dead
//      rule that looks alive.
//   2. a `use_lane` / `max_lane` / `allowed_lanes` value that is NOT a key in
//      lanes.yaml: the resolver silently skips a missing use_lane (lane-resolver
//      step 1 "fall through") / applyCaps ignores an unrankable cap — the policy
//      silently fails to do what it says.
// These guards turn both into a RED test. They must be green for today's 3
// policies and will protect Phase 1/2 policy additions.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const configDir = join(repoRoot, "config");

function readYaml(file: string): unknown {
  return parseYaml(readFileSync(join(configDir, file), "utf8"));
}

const policies = PoliciesConfigSchema.parse(readYaml("policies.yaml"));
const lanes = LanesConfigSchema.parse(readYaml("lanes.yaml"));
const laneKeys = new Set(Object.keys(lanes));
const taskSet = new Set<string>(ALL_TASKS);

describe("policies.yaml cross-reference guards", () => {
  it("loads the shipped policies for the guards to inspect (sanity)", () => {
    expect(policies.policies.length).toBeGreaterThan(0);
    expect(laneKeys.size).toBeGreaterThan(0);
  });

  it("every match.task_type is in the closed TaskType union (no silent dead rule)", () => {
    const offenders: Array<{ id: string; task_type: string }> = [];
    policies.policies.forEach((p, i) => {
      const tt = p.match.task_type;
      if (tt !== undefined && !taskSet.has(tt)) {
        offenders.push({ id: p.id ?? `policy[${i}]`, task_type: tt });
      }
    });
    expect(offenders).toEqual([]);
  });

  it("every use_lane / max_lane / allowed_lanes value is a real lanes.yaml key", () => {
    const offenders: Array<{ id: string; field: string; lane: string }> = [];
    policies.policies.forEach((p, i) => {
      const id = p.id ?? `policy[${i}]`;
      const check = (field: string, lane: string | undefined): void => {
        if (lane !== undefined && !laneKeys.has(lane)) {
          offenders.push({ id, field, lane });
        }
      };
      check("use_lane", p.use_lane);
      check("max_lane", p.max_lane);
      for (const lane of p.allowed_lanes ?? []) check("allowed_lanes", lane);
    });
    expect(offenders).toEqual([]);
  });
});
