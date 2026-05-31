import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HelmConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const configDir = join(repoRoot, "config");

function readYaml(file: string): unknown {
  return parseYaml(readFileSync(join(configDir, file), "utf8"));
}

describe("checked-in config samples", () => {
  it("parse and merge into a valid HelmConfig", () => {
    const merged = {
      server: readYaml("server.yaml"),
      auth: readYaml("auth.yaml"),
      ...(readYaml("providers.yaml") as Record<string, unknown>),
      runtime: readYaml("runtime.yaml"),
    };
    const res = HelmConfigSchema.safeParse(merged);
    expect(res.success).toBe(true);
  });

  it("providers.yaml references credentials by env var name, never plaintext", () => {
    const raw = readFileSync(join(configDir, "providers.yaml"), "utf8");
    expect(raw).toContain("api_key_env");
    // no plaintext credential field
    expect(/api_key\s*:/.test(raw)).toBe(false);
    expect(raw).not.toContain("sk-");
  });

  it(".env.example documents required admin + provider variables (placeholders only)", () => {
    const env = readFileSync(join(repoRoot, ".env.example"), "utf8");
    expect(env).toContain("HELM_ADMIN_USER");
    expect(env).toContain("HELM_ADMIN_PASSWORD");
    expect(/[A-Z]+_API_KEY/.test(env)).toBe(true);
    // placeholder, not a real key
    expect(env).toContain("sk-...");
  });

  it("loadConfig consumes the samples and returns a typed Config", () => {
    const cfg = loadConfig({ configDir, env: {} });
    expect(cfg.auth.require_api_key).toBe(true);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.providers[0]?.api_key_env).toBe("OPENAI_API_KEY");
  });

  it("loads the shipped lanes.yaml (economy/balanced/premium + task lanes)", () => {
    const cfg = loadConfig({ configDir, env: {} });
    const lanes = cfg.lanes;
    if (lanes === undefined) throw new Error("config/lanes.yaml must load into config.lanes");
    // quality/cost lanes (balanced is the classification fallback terminal)
    expect(lanes.economy).toBeDefined();
    expect(lanes.balanced).toBeDefined();
    expect(lanes.premium).toBeDefined();
    // task lanes
    expect(lanes.coding?.fallback).toEqual(["premium", "balanced"]);
    expect(lanes.json?.constraints.require_json).toBe(true);
    expect(lanes.vision?.constraints.require_vision).toBe(true);
    expect(lanes.tool_use?.constraints.require_tools).toBe(true);
  });

  it("loads the shipped policies.yaml as first-match rules", () => {
    const cfg = loadConfig({ configDir, env: {} });
    const ids = cfg.policies.policies.map((p) => p.id);
    expect(ids).toContain("coding_complex_to_coding_lane");
    expect(ids).toContain("json_constrained_to_json_lane");
    // first-match ordering: the coding rule precedes the json rule
    expect(cfg.policies.policies[0]?.use_lane).toBe("coding");
  });

  it("lanes.yaml is genuinely schema-constrained (a bad lane fails the merge)", () => {
    const lanes = readYaml("lanes.yaml") as Record<string, unknown>;
    const broken = {
      server: readYaml("server.yaml"),
      auth: readYaml("auth.yaml"),
      ...(readYaml("providers.yaml") as Record<string, unknown>),
      runtime: readYaml("runtime.yaml"),
      lanes: { ...lanes, broken_lane: { primary: "" } }, // empty primary -> invalid
    };
    expect(HelmConfigSchema.safeParse(broken).success).toBe(false);
  });

  it("the samples are genuinely schema-constrained (breaking one fails)", () => {
    const broken = {
      server: readYaml("server.yaml"),
      auth: { ...(readYaml("auth.yaml") as Record<string, unknown>), require_api_key: "yes" },
      ...(readYaml("providers.yaml") as Record<string, unknown>),
      runtime: readYaml("runtime.yaml"),
    };
    expect(HelmConfigSchema.safeParse(broken).success).toBe(false);
  });
});
