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

  it("ships eval enabled with documented eval defaults", () => {
    const cfg = loadConfig({ configDir, env: {} });
    expect(cfg.classifier.eval.enabled).toBe(true);
    expect(cfg.classifier.eval.max_tokens).toBe(256);
    // eval-timeout semantics (2026-06-25): timeout_ms is now the PER-CANDIDATE deadline
    // the loopback hands to the executor (a slow head model times out → falls back to the
    // next candidate, breaker fault + advance), and outer_timeout_ms is the TOTAL eval
    // budget across fallback hops (the final fail-open guard). Pin the values so a drift
    // back to the old 250 (which always timed out in prod) fails CI.
    expect(cfg.classifier.eval.timeout_ms).toBe(3000);
    expect(cfg.classifier.eval.outer_timeout_ms).toBe(8000);
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
