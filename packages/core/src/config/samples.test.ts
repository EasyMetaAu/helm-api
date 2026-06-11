import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HelmConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { resolveModelAlias, validateModelAliasTargets } from "../routing/model-alias.js";
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
    expect(cfg.providers[0]?.api_key_env).toBe("DEEPSEEK_API_KEY");
    expect(cfg.providers[0]?.map_developer_role_to_system).toBe(true);
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

  it("loads the shipped model-aliases.yaml with every target a real shipped lane or auto", () => {
    const cfg = loadConfig({ configDir, env: {} });
    const aliases = cfg.model_aliases;
    if (aliases === undefined) throw new Error("config/model-aliases.yaml must load");
    // Covers the Claude Code default (claude-opus-4-8 -> a lane), proving the shim.
    const laneNames = Object.keys(cfg.lanes ?? {});
    const opusTarget = resolveModelAlias("claude-opus-4-8", aliases);
    expect(opusTarget && laneNames.includes(opusTarget)).toBe(true);
    // The small/fast background model maps to the dedicated claude-haiku lane even
    // with a date suffix (the common dated Haiku id shape) — the haiku-specific glob
    // wins over the broad claude-* catch-all (which still falls through to balanced).
    expect(resolveModelAlias("claude-3-5-haiku-20241022", aliases)).toBe("claude-haiku");
    // GPT families route to their dedicated vendor-family lanes. The cheap mini must
    // NOT be swallowed by the broad `gpt-5*` -> premium catch-all (longest-literal
    // wins): a dated mini id still lands on the cheap gpt-5.4-mini lane.
    expect(resolveModelAlias("gpt-5.4", aliases)).toBe("gpt-5.4");
    expect(resolveModelAlias("gpt-5.4-mini", aliases)).toBe("gpt-5.4-mini");
    expect(resolveModelAlias("gpt-5.4-mini-2026-01-01", aliases)).toBe("gpt-5.4-mini");
    // The shipped aliases must validate against the SHIPPED lanes (no drift): every
    // target is a configured lane or "auto", or the gateway would refuse to boot.
    expect(validateModelAliasTargets(aliases, laneNames)).toEqual([]);
  });

  it("loads the shipped gpt-5.4 vendor-family lanes leading with the real codex models", () => {
    const cfg = loadConfig({ configDir, env: {} });
    const lanes = cfg.lanes;
    if (lanes === undefined) throw new Error("config/lanes.yaml must load into config.lanes");
    expect(lanes["gpt-5.4"]?.primary).toBe("openai-codex/gpt-5.4");
    expect(lanes["gpt-5.4"]?.fallback).toEqual(["premium"]);
    expect(lanes["gpt-5.4-mini"]?.primary).toBe("openai-codex/gpt-5.4-mini");
    expect(lanes["gpt-5.4-mini"]?.fallback).toEqual(["economy"]);
  });

  it("routes bare Gemini ids onto the gemini vendor-family lanes (pro vs flash vs catch-all)", () => {
    const cfg = loadConfig({ configDir, env: {} });
    const lanes = cfg.lanes;
    const aliases = cfg.model_aliases;
    if (lanes === undefined) throw new Error("config/lanes.yaml must load into config.lanes");
    if (aliases === undefined) throw new Error("config/model-aliases.yaml must load");
    // Vendor-family lanes lead with the static ZenMux Gemini keys (the only Gemini
    // upstream wired): pro -> gemini-3.1-pro (latest Pro ZenMux serves), flash ->
    // gemini-3.5-flash (latest GA Flash).
    expect(lanes["gemini-pro"]?.primary).toBe("zenmux/gemini-3.1-pro");
    expect(lanes["gemini-pro"]?.fallback).toEqual(["premium"]);
    expect(lanes["gemini-flash"]?.primary).toBe("zenmux/gemini-3.5-flash");
    expect(lanes["gemini-flash"]?.fallback).toEqual(["balanced"]);
    // Longest-literal wins: `*pro*` / `*flash*` beat the `gemini-*` catch-all, and
    // the middle `*` absorbs the version + any -preview/-latest suffix.
    expect(resolveModelAlias("gemini-3.1-pro-preview", aliases)).toBe("gemini-pro");
    expect(resolveModelAlias("gemini-2.5-pro", aliases)).toBe("gemini-pro");
    expect(resolveModelAlias("gemini-3.5-flash", aliases)).toBe("gemini-flash");
    expect(resolveModelAlias("gemini-3.1-flash-lite", aliases)).toBe("gemini-flash");
    // An id matching neither tier falls through the catch-all to balanced.
    expect(resolveModelAlias("gemini-embedding-001", aliases)).toBe("balanced");
  });

  it("loads the shipped policies.yaml as first-match rules", () => {
    const cfg = loadConfig({ configDir, env: {} });
    const ids = cfg.policies.policies.map((p) => p.id);
    expect(ids).toContain("coding_complex_to_coding_lane");
    expect(ids).toContain("json_constrained_to_json_lane");
    // first-match ordering (eval-v2 port 2026-05-31): the JSON output contract
    // dominates the soft cost/quality steering rules, so json_constrained is the
    // FIRST policy. Specific-before-general within a task: coding_complex precedes
    // the coding_simple→economy rule so complex coding is never down-routed.
    expect(cfg.policies.policies[0]?.use_lane).toBe("json");
    expect(ids.indexOf("coding_complex_to_coding_lane")).toBeLessThan(
      ids.indexOf("coding_simple_to_economy"),
    );
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
