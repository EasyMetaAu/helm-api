import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const configDir = join(repoRoot, "config");

// The real config/classifier.yaml must load + validate through the same
// loadConfig mechanism as the other yaml files (config-as-code, fail-closed).
describe("checked-in classifier.yaml sample", () => {
  it("loadConfig merges classifier.yaml into a typed HelmConfig", () => {
    const cfg = loadConfig({ configDir, env: {} });
    expect(cfg.classifier).toBeDefined();
    // Values pinned to the 2026-06-01 lane-calibration (see config/classifier.yaml
    // header): the original ship (0.45 / k=8 / -0.10,0.08,0.35) made the Layer-1
    // confidence gate unreachable, collapsing every request to balanced.
    expect(cfg.classifier.rules.confidence_threshold).toBe(0.42);
    expect(cfg.classifier.rules.sigmoid_k).toBe(12);
    expect(cfg.classifier.rules.tier_boundaries).toEqual({
      standard: -0.06,
      complex: 0.3,
      reasoning: 0.85,
    });
  });

  it("ships eval disabled by default with documented eval defaults", () => {
    const cfg = loadConfig({ configDir, env: {} });
    expect(cfg.classifier.eval.enabled).toBe(false);
    expect(cfg.classifier.eval.max_tokens).toBe(256);
    // eval-fast-probe (2026-06-07): the eval timeouts were tightened from 250/350
    // to 1500/2000 once `extra_body.thinking:disabled` removed the eval model's
    // reasoning round-trip (~2-3s → ~1s). The tight timeout is now SAFE because the
    // call is fast, not loose to tolerate a slow one. Pin the new values + the
    // passthrough so a drift back to 250 (which always timed out in prod) fails CI.
    expect(cfg.classifier.eval.timeout_ms).toBe(1500);
    expect(cfg.classifier.eval.outer_timeout_ms).toBe(2000);
    expect(cfg.classifier.eval.extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(cfg.classifier.eval.on_failure).toBe("balanced");
    expect(cfg.classifier.eval.cache.ttl_sec).toBe(300);
  });

  it("populates dimensions, task_keywords and tool_prefixes from data", () => {
    const cfg = loadConfig({ configDir, env: {} });
    expect(Object.keys(cfg.classifier.rules.dimensions).length).toBeGreaterThanOrEqual(14);
    expect(cfg.classifier.rules.task_keywords.coding).toContain("function");
    expect(cfg.classifier.rules.tool_prefixes.web).toContain("browser_");
    expect(cfg.classifier.rules.task_activation.web).toBe(3.0);
  });
});
