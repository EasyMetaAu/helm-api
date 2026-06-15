import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createYamlRulePersister } from "./yaml-writeback.js";

// yaml-writeback — the YAML write-back adapter foreshadowed in rule-store.ts:
// admin rule edits (lanes / policies / classifier) persist to config/*.yaml so
// the FILE stays the canonical config (CLAUDE.md principle 2, 配置即代码) and a
// restart re-loads exactly what the operator saved. Writes are comment-PRESERVING
// (yaml Document API — the shipped files are heavily documented) and atomic
// (tmp + rename, never a torn file). A write failure THROWS so the route can
// fail-closed (500, live config unchanged) — file and memory never diverge.

const LANES_FIXTURE = `# lanes.yaml — top-of-file comment that must survive writes.
economy:
  # economy lane comment
  purpose: Cheap and fast
  primary: deepseek/deepseek-v4-flash
  fallback:
    - balanced

balanced:
  purpose: Default tradeoff
  primary: deepseek/deepseek-v4-pro
  fallback: []
`;

const POLICIES_FIXTURE = `# policies.yaml — header comment that must survive writes.
policies:
  - match: { needs_json: true }
    use_lane: json
`;

const CLASSIFIER_FIXTURE = `# classifier.yaml — header comment that must survive writes.
classifier:
  rules:
    enabled: true
    # threshold comment that must survive a value edit on the SAME key
    confidence_threshold: 0.42
    sigmoid_k: 12
  eval:
    enabled: false
    model: deepseek-v4-flash
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "helm-yaml-writeback-"));
  writeFileSync(join(dir, "lanes.yaml"), LANES_FIXTURE);
  writeFileSync(join(dir, "policies.yaml"), POLICIES_FIXTURE);
  writeFileSync(join(dir, "classifier.yaml"), CLASSIFIER_FIXTURE);
});

afterEach(() => {
  // restore perms so rm never fails after the read-only test
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe("createYamlRulePersister — classifier", () => {
  it("updates edited values in place, preserving comments and untouched keys", async () => {
    const p = createYamlRulePersister(dir);
    await p.persistClassifier({
      rules: { enabled: true, confidence_threshold: 0.5, sigmoid_k: 12 },
      eval: { enabled: true, model: "deepseek-v4-flash" },
    } as never);

    const text = readFileSync(join(dir, "classifier.yaml"), "utf8");
    expect(text).toContain("header comment that must survive writes");
    expect(text).toContain("threshold comment that must survive");

    const parsed = parseYaml(text) as {
      classifier: {
        rules: { confidence_threshold: number; sigmoid_k: number };
        eval: { enabled: boolean; model: string };
      };
    };
    expect(parsed.classifier.rules.confidence_threshold).toBe(0.5);
    expect(parsed.classifier.eval.enabled).toBe(true);
    // untouched siblings survive
    expect(parsed.classifier.rules.sigmoid_k).toBe(12);
    expect(parsed.classifier.eval.model).toBe("deepseek-v4-flash");
  });

  it("leaves no tmp file behind (atomic rename)", async () => {
    const p = createYamlRulePersister(dir);
    await p.persistClassifier({ rules: { enabled: true }, eval: { enabled: false } } as never);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("createYamlRulePersister — lanes (flat top-level map)", () => {
  it("edits, adds and DELETES lanes so the file mirrors the saved set exactly", async () => {
    const p = createYamlRulePersister(dir);
    await p.persistLanes({
      economy: { purpose: "Cheap and fast", primary: "openrouter/x", fallback: ["balanced"] },
      premium: { purpose: "Best quality", primary: "anthropic/claude", fallback: [] },
      // `balanced` intentionally absent -> must be deleted from the file
    } as never);

    const text = readFileSync(join(dir, "lanes.yaml"), "utf8");
    expect(text).toContain("top-of-file comment that must survive");
    expect(text).toContain("economy lane comment"); // comment on a surviving, edited lane

    const parsed = parseYaml(text) as Record<string, { primary: string } | undefined>;
    expect(parsed.economy?.primary).toBe("openrouter/x");
    expect(parsed.premium?.primary).toBe("anthropic/claude");
    expect(parsed.balanced).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual(["economy", "premium"]);
  });
});

describe("createYamlRulePersister — policies", () => {
  it("replaces the policies list, preserving the header comment", async () => {
    const p = createYamlRulePersister(dir);
    await p.persistPolicies({
      policies: [
        { match: { task_type: "coding" }, use_lane: "coding" },
        { match: {}, allowed_lanes: ["economy", "balanced"] },
      ],
    } as never);

    const text = readFileSync(join(dir, "policies.yaml"), "utf8");
    expect(text).toContain("header comment that must survive");
    const parsed = parseYaml(text) as { policies: Array<Record<string, unknown>> };
    expect(parsed.policies).toHaveLength(2);
    expect(parsed.policies[0]).toMatchObject({ use_lane: "coding" });
  });
});

describe("createYamlRulePersister — edge cases", () => {
  it("creates the file when it does not exist yet", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "helm-yaml-fresh-"));
    try {
      const p = createYamlRulePersister(fresh);
      await p.persistLanes({
        balanced: { purpose: "d", primary: "a/b", fallback: [] },
      } as never);
      expect(existsSync(join(fresh, "lanes.yaml"))).toBe(true);
      const parsed = parseYaml(readFileSync(join(fresh, "lanes.yaml"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(parsed.balanced).toBeDefined();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("THROWS on an unwritable config dir (fail-closed: the route must 500)", async () => {
    chmodSync(dir, 0o555); // read + execute only
    const p = createYamlRulePersister(dir);
    await expect(
      p.persistClassifier({ rules: { enabled: true }, eval: { enabled: false } } as never),
    ).rejects.toThrow();
    // the original file is untouched
    const parsed = parseYaml(readFileSync(join(dir, "classifier.yaml"), "utf8")) as {
      classifier: { eval: { enabled: boolean } };
    };
    expect(parsed.classifier.eval.enabled).toBe(false);
  });
});
