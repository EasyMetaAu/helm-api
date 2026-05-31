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
    expect(cfg.classifier.rules.confidence_threshold).toBe(0.45);
    expect(cfg.classifier.rules.sigmoid_k).toBe(8);
    expect(cfg.classifier.rules.tier_boundaries).toEqual({
      standard: -0.1,
      complex: 0.08,
      reasoning: 0.35,
    });
  });

  it("ships eval disabled by default with documented eval defaults", () => {
    const cfg = loadConfig({ configDir, env: {} });
    expect(cfg.classifier.eval.enabled).toBe(false);
    expect(cfg.classifier.eval.max_tokens).toBe(256);
    expect(cfg.classifier.eval.timeout_ms).toBe(300);
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
