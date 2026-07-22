import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./loader.js";

// In-memory fake fs: maps a file path to its YAML contents. Injected via
// readFile so tests stay hermetic (no real disk, no real env).
function fakeReadFile(files: Record<string, string>) {
  return (path: string): string => {
    const content = files[path];
    if (content === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return content;
  };
}

const VALID_YAML = {
  "config/server.yaml": "host: 127.0.0.1\nport: 8080\nbase_path: /\n",
  "config/auth.yaml":
    "require_api_key: true\nbootstrap:\n  generate_if_missing: true\n  persist_to: ./data/helm-keys.json\n  print_once: true\n",
  "config/providers.yaml":
    "providers:\n  - alias: openai\n    type: openai\n    base_url: https://api.openai.com/v1\n    api_key_env: OPENAI_API_KEY\n",
  "config/runtime.yaml":
    "request_timeout_ms: 60000\nrate_limit:\n  enabled: false\n  default:\n    rpm: 0\n    tpm: 0\n",
};

describe("loadConfig", () => {
  it("returns a typed config from valid yaml", () => {
    const cfg = loadConfig({
      configDir: "config",
      env: {},
      readFile: fakeReadFile(VALID_YAML),
    });
    expect(cfg.auth.require_api_key).toBe(true);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.providers[0]?.api_key_env).toBe("OPENAI_API_KEY");
    expect(cfg.providers[0]?.map_developer_role_to_system).toBe(false);
  });

  it("loads the provider developer-role compatibility flag", () => {
    const cfg = loadConfig({
      configDir: "config",
      env: {},
      readFile: fakeReadFile({
        ...VALID_YAML,
        "config/providers.yaml":
          "providers:\n  - alias: deepseek\n    type: openai\n    base_url: https://api.deepseek.com/v1\n    api_key_env: DEEPSEEK_API_KEY\n    map_developer_role_to_system: true\n",
      }),
    });
    expect(cfg.providers[0]?.map_developer_role_to_system).toBe(true);
  });

  it("loads the provider Claude CLI fingerprint mode and rejects typos", () => {
    const cfg = loadConfig({
      configDir: "config",
      env: {},
      readFile: fakeReadFile({
        ...VALID_YAML,
        "config/providers.yaml":
          "providers:\n  - alias: anthropic\n    type: anthropic\n    base_url: https://api.anthropic.com\n    api_key_env: ANTHROPIC_API_KEY\n    claude_cli_fingerprint_mode: strict\n",
      }),
    });
    expect(cfg.providers[0]?.claude_cli_fingerprint_mode).toBe("strict");

    expect(() =>
      loadConfig({
        configDir: "config",
        env: {},
        readFile: fakeReadFile({
          ...VALID_YAML,
          "config/providers.yaml":
            "providers:\n  - alias: anthropic\n    type: anthropic\n    base_url: https://api.anthropic.com\n    api_key_env: ANTHROPIC_API_KEY\n    claude_cli_fingerprint_mode: aggressive\n",
        }),
      }),
    ).toThrow(ConfigError);
  });

  it("lets env override file values (env wins) with coercion", () => {
    const cfg = loadConfig({
      configDir: "config",
      env: { HELM_PORT: "9090" },
      readFile: fakeReadFile(VALID_YAML),
    });
    expect(cfg.server.port).toBe(9090);
    expect(cfg.server.host).toBe("127.0.0.1"); // untouched file value
  });

  it("defaults runtime.store.driver to sqlite and lets HELM_STORE_DRIVER override it", () => {
    const dflt = loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(VALID_YAML) });
    expect(dflt.runtime.store.driver).toBe("sqlite");
    const cfg = loadConfig({
      configDir: "config",
      env: { HELM_STORE_DRIVER: "supabase", HELM_STORE_URL_ENV: "HELM_STORE_URL" },
      readFile: fakeReadFile(VALID_YAML),
    });
    expect(cfg.runtime.store.driver).toBe("supabase");
    expect(cfg.runtime.store.url_env).toBe("HELM_STORE_URL");
  });

  it("defaults routing signal feedback off and lets HELM_SIGNAL_FEEDBACK_ENABLED turn it on", () => {
    const dflt = loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(VALID_YAML) });
    expect(dflt.runtime.signal_feedback.enabled).toBe(false);
    const cfg = loadConfig({
      configDir: "config",
      env: { HELM_SIGNAL_FEEDBACK_ENABLED: "true" },
      readFile: fakeReadFile(VALID_YAML),
    });
    expect(cfg.runtime.signal_feedback.enabled).toBe(true);
    expect(cfg.runtime.signal_feedback.min_samples).toBe(20);
  });

  it("lets env configure the memory LLM model and task-specific overrides", () => {
    const cfg = loadConfig({
      configDir: "config",
      env: {
        HELM_MEMORY_LLM_ENABLED: "true",
        HELM_MEMORY_LLM_MODEL: "deepseek/deepseek-v4-flash",
        HELM_MEMORY_LLM_OBSERVATION_MODEL: "openai/gpt-4.1-mini",
        HELM_MEMORY_LLM_REFLECTION_MODEL: "anthropic/claude-sonnet-4",
        HELM_MEMORY_LLM_FACTS_MODEL: "openai/gpt-4.1-nano",
        HELM_MEMORY_LLM_TIMEOUT_MS: "12345",
        HELM_MEMORY_LLM_TEMPERATURE: "0.2",
        HELM_MEMORY_LLM_FACTS_MAX_TOKENS: "432",
      },
      readFile: fakeReadFile(VALID_YAML),
    });
    expect(cfg.memory.llm.enabled).toBe(true);
    expect(cfg.memory.llm.model).toBe("deepseek/deepseek-v4-flash");
    expect(cfg.memory.llm.observation_model).toBe("openai/gpt-4.1-mini");
    expect(cfg.memory.llm.reflection_model).toBe("anthropic/claude-sonnet-4");
    expect(cfg.memory.llm.facts_model).toBe("openai/gpt-4.1-nano");
    expect(cfg.memory.llm.timeout_ms).toBe(12345);
    expect(cfg.memory.llm.temperature).toBe(0.2);
    expect(cfg.memory.llm.max_tokens.facts).toBe(432);
  });

  it("fails closed when HELM_STORE_DRIVER is an unknown driver", () => {
    expect(() =>
      loadConfig({
        configDir: "config",
        env: { HELM_STORE_DRIVER: "mysql" },
        readFile: fakeReadFile(VALID_YAML),
      }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError with issues on invalid config (fail-closed)", () => {
    const invalid = {
      ...VALID_YAML,
      "config/auth.yaml":
        "require_api_key: yes-please\nbootstrap:\n  persist_to: ./data/helm-keys.json\n",
    };
    try {
      loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(invalid) });
      throw new Error("expected loadConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      if (e instanceof ConfigError) {
        expect(e.issues.length).toBeGreaterThan(0);
        expect(e.issues.some((i) => i.path.includes("require_api_key"))).toBe(true);
      }
    }
  });

  it("throws ConfigError (not a partial object) on a non-numeric HELM_PORT", () => {
    expect(() =>
      loadConfig({
        configDir: "config",
        env: { HELM_PORT: "abc" },
        readFile: fakeReadFile(VALID_YAML),
      }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError on missing/unreadable config files (fail-closed)", () => {
    expect(() => loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile({}) })).toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError on a YAML syntax error", () => {
    const broken = { ...VALID_YAML, "config/server.yaml": "port: : : bad\n" };
    expect(() =>
      loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(broken) }),
    ).toThrow(ConfigError);
  });

  // —— lanes.yaml / policies.yaml (config.load-rules) ——

  const LANES_YAML =
    "balanced:\n  primary: default_good_model\n  fallback: [premium, economy]\n" +
    "premium:\n  primary: best_reasoning_model\n  fallback: [balanced]\n" +
    "coding:\n  primary: coding_model\n  fallback: [premium, balanced]\n  constraints:\n    require_tools: true\n";
  const POLICIES_YAML =
    "policies:\n  - id: coding_complex\n    match:\n      task_type: coding\n      complexity: complex\n    use_lane: coding\n  - id: json_strict\n    match:\n      needs_json: true\n    use_lane: json\n";

  it("loads lanes.yaml into config.lanes (validated, with task lanes)", () => {
    const cfg = loadConfig({
      configDir: "config",
      env: {},
      readFile: fakeReadFile({ ...VALID_YAML, "config/lanes.yaml": LANES_YAML }),
    });
    expect(cfg.lanes?.balanced?.primary).toBe("default_good_model");
    expect(cfg.lanes?.coding?.fallback).toEqual(["premium", "balanced"]);
    expect(cfg.lanes?.coding?.constraints.require_tools).toBe(true);
  });

  it("loads policies.yaml into config.policies (first-match rules)", () => {
    const cfg = loadConfig({
      configDir: "config",
      env: {},
      readFile: fakeReadFile({ ...VALID_YAML, "config/policies.yaml": POLICIES_YAML }),
    });
    expect(cfg.policies.policies).toHaveLength(2);
    expect(cfg.policies.policies[0]?.match.task_type).toBe("coding");
    expect(cfg.policies.policies[0]?.use_lane).toBe("coding");
  });

  it("lanes.yaml is optional: absent -> config.lanes is undefined (server falls back to DEFAULT_LANES)", () => {
    const cfg = loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(VALID_YAML) });
    expect(cfg.lanes).toBeUndefined();
    expect(cfg.policies.policies).toEqual([]);
  });

  it("accepts lanes.yaml without balanced; runtime.default_lane is validated at composition", () => {
    const lanes = "economy:\n  primary: cheap_model\n  fallback: [premium]\n";
    const cfg = loadConfig({
      configDir: "config",
      env: {},
      readFile: fakeReadFile({ ...VALID_YAML, "config/lanes.yaml": lanes }),
    });
    expect(cfg.lanes?.economy?.primary).toBe("cheap_model");
  });

  it("fail-closed: a policy with no action field throws ConfigError", () => {
    const badPolicies = "policies:\n  - match:\n      task_type: coding\n";
    expect(() =>
      loadConfig({
        configDir: "config",
        env: {},
        readFile: fakeReadFile({ ...VALID_YAML, "config/policies.yaml": badPolicies }),
      }),
    ).toThrow(ConfigError);
  });

  // —— memory.yaml (docs/12 P1 "Config surface") ——
  // The memory subtree is NEW (docs/08 left config.memory deferred). Absent file
  // → all defaults (forgetting.enabled:false, gateway boots, behaviour identical
  // to today). Present-but-invalid → fail-closed (CLAUDE.md principle 2).

  it("memory.yaml is optional: absent -> config.memory defaults (forgetting.enabled:false)", () => {
    const cfg = loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(VALID_YAML) });
    expect(cfg.memory.forgetting.enabled).toBe(false);
    expect(cfg.memory.forgetting.score.half_life_s).toBe(86400);
  });

  it("loads memory.yaml: a non-default half_life_s round-trips and takes effect", () => {
    const memYaml = "forgetting:\n  enabled: true\n  score:\n    half_life_s: 3600\n";
    const cfg = loadConfig({
      configDir: "config",
      env: {},
      readFile: fakeReadFile({ ...VALID_YAML, "config/memory.yaml": memYaml }),
    });
    expect(cfg.memory.forgetting.enabled).toBe(true);
    expect(cfg.memory.forgetting.score.half_life_s).toBe(3600);
    expect(cfg.memory.forgetting.inject.drop_order).toBe("score"); // untouched default
  });

  it("loads memory.yaml: memory LLM extraction/compaction model config round-trips", () => {
    const memYaml =
      "llm:\n  enabled: true\n  model: deepseek/deepseek-v4-flash\n  reflection_model: openai/gpt-4.1-mini\n  max_tokens:\n    observation: 512\n";
    const cfg = loadConfig({
      configDir: "config",
      env: {},
      readFile: fakeReadFile({ ...VALID_YAML, "config/memory.yaml": memYaml }),
    });
    expect(cfg.memory.llm.enabled).toBe(true);
    expect(cfg.memory.llm.model).toBe("deepseek/deepseek-v4-flash");
    expect(cfg.memory.llm.reflection_model).toBe("openai/gpt-4.1-mini");
    expect(cfg.memory.llm.max_tokens.observation).toBe(512);
    expect(cfg.memory.llm.max_tokens.reflection).toBe(1200);
  });

  it("fail-closed: an unknown/misspelled memory.yaml key (strict) throws ConfigError", () => {
    const badMem = "forgetting:\n  score:\n    half_life_s: 3600\n  halflife_s: 99\n";
    expect(() =>
      loadConfig({
        configDir: "config",
        env: {},
        readFile: fakeReadFile({ ...VALID_YAML, "config/memory.yaml": badMem }),
      }),
    ).toThrow(ConfigError);
  });

  it("fail-closed: memory.yaml with importance_floor > importance_ceil throws ConfigError", () => {
    const badMem = "forgetting:\n  score:\n    importance_floor: 0.9\n    importance_ceil: 0.1\n";
    expect(() =>
      loadConfig({
        configDir: "config",
        env: {},
        readFile: fakeReadFile({ ...VALID_YAML, "config/memory.yaml": badMem }),
      }),
    ).toThrow(ConfigError);
  });

  it("fail-closed: an unknown field in a lane (strict) throws ConfigError", () => {
    const badLanes = "balanced:\n  primary: default_good_model\n  weight: 5\n";
    expect(() =>
      loadConfig({
        configDir: "config",
        env: {},
        readFile: fakeReadFile({ ...VALID_YAML, "config/lanes.yaml": badLanes }),
      }),
    ).toThrow(ConfigError);
  });

  it("fail-closed with a clear diagnostic when a key:null file has a non-mapping root (scalar)", () => {
    const bad = { ...VALID_YAML, "config/providers.yaml": "just-a-string\n" };
    try {
      loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(bad) });
      throw new Error("expected loadConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      if (e instanceof ConfigError) {
        expect(e.message).toContain("config/providers.yaml");
        expect(e.message).toContain("expected a mapping");
      }
    }
  });

  it("fail-closed with a clear diagnostic when a key:null file has an array root", () => {
    const bad = { ...VALID_YAML, "config/providers.yaml": "- a\n- b\n" };
    try {
      loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(bad) });
      throw new Error("expected loadConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      if (e instanceof ConfigError) {
        expect(e.message).toContain("expected a mapping");
      }
    }
  });

  it("fail-closed with a clear diagnostic when a keyed file has a non-mapping root", () => {
    const bad = { ...VALID_YAML, "config/server.yaml": "- 1\n- 2\n" };
    try {
      loadConfig({ configDir: "config", env: {}, readFile: fakeReadFile(bad) });
      throw new Error("expected loadConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      if (e instanceof ConfigError) {
        expect(e.message).toContain("config/server.yaml");
        expect(e.message).toContain("expected a mapping");
      }
    }
  });

  it("never echoes plaintext secrets in error messages", () => {
    const invalid = {
      ...VALID_YAML,
      "config/server.yaml": "port: 70000\n",
    };
    try {
      loadConfig({
        configDir: "config",
        env: { OPENAI_API_KEY: "sk-supersecret-1234", HELM_ADMIN_PASSWORD: "hunter2" },
        readFile: fakeReadFile(invalid),
      });
    } catch (e) {
      if (e instanceof ConfigError) {
        expect(e.message).not.toContain("sk-supersecret-1234");
        expect(e.message).not.toContain("hunter2");
      }
    }
  });
});
