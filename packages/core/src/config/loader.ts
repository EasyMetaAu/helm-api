import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HelmConfigSchema } from "@helm/shared";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { type ConfigPath, coerceEnvValue, ENV_MAPPINGS } from "./env-map.js";

export type Config = z.infer<typeof HelmConfigSchema>;

// Thrown on any invalid/missing/unparseable config. Carries per-issue detail so
// the caller can print actionable diagnostics and exit non-zero (fail-closed).
// The caller (gateway entry) is responsible for process.exit(1).
export class ConfigError extends Error {
  readonly issues: z.core.$ZodIssue[];
  constructor(message: string, issues: z.core.$ZodIssue[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface LoadConfigOptions {
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

// The yaml files that compose a HelmConfig and the top-level key each maps to.
const CONFIG_FILES: ReadonlyArray<{ file: string; key: keyof Config | null }> = [
  { file: "server.yaml", key: "server" },
  { file: "auth.yaml", key: "auth" },
  { file: "providers.yaml", key: null }, // providers.yaml has a top-level `providers:` key
  { file: "runtime.yaml", key: "runtime" },
];

type Mutable = Record<string, unknown>;

function setPath(root: Mutable, path: ConfigPath, value: unknown): void {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    if (typeof node[seg] !== "object" || node[seg] === null) {
      node[seg] = {};
    }
    node = node[seg] as Mutable;
  }
  node[path[path.length - 1] as string] = value;
}

function applyEnvOverrides(tree: Mutable, env: NodeJS.ProcessEnv): void {
  for (const mapping of ENV_MAPPINGS) {
    const raw = env[mapping.env];
    if (raw === undefined) continue;
    setPath(tree, mapping.path, coerceEnvValue(raw, mapping.kind));
  }
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const configDir = opts.configDir ?? "./config";
  const env = opts.env ?? process.env;
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const tree: Mutable = {};

  for (const { file, key } of CONFIG_FILES) {
    const path = join(configDir, file);
    let text: string;
    try {
      text = read(path);
    } catch {
      throw new ConfigError(`failed to read config file: ${path}`, []);
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch {
      throw new ConfigError(`failed to parse YAML: ${path}`, []);
    }

    const obj = (parsed ?? {}) as Mutable;
    if (key === null) {
      // providers.yaml: merge its top-level keys (e.g. `providers`) into the tree
      Object.assign(tree, obj);
    } else {
      tree[key] = obj;
    }
  }

  // env wins over file values
  applyEnvOverrides(tree, env);

  const result = HelmConfigSchema.safeParse(tree);
  if (!result.success) {
    // Diagnostics carry field paths only — never plaintext secret values.
    throw new ConfigError("invalid configuration", result.error.issues);
  }
  return result.data;
}

// Render issues as human-readable lines (path + message). Deliberately does NOT
// include offending values, so secrets injected via env are never echoed.
export function formatIssues(issues: ReadonlyArray<z.core.$ZodIssue>): string {
  return issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
