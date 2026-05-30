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
    "max_request_bytes: 2000000\nrequest_timeout_ms: 60000\nrate_limit:\n  enabled: false\n  default:\n    rpm: 0\n    tpm: 0\n",
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
