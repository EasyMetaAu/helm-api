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
// `optional: true` files may be absent (the schema default fills them in); a
// present-but-broken optional file still fails closed (YAML/validation errors).
const CONFIG_FILES: ReadonlyArray<{
  file: string;
  key: keyof Config | null;
  optional?: boolean;
}> = [
  { file: "server.yaml", key: "server" },
  { file: "auth.yaml", key: "auth" },
  { file: "providers.yaml", key: null }, // providers.yaml has a top-level `providers:` key
  { file: "runtime.yaml", key: "runtime" },
  // classifier.yaml has a top-level `classifier:` key; optional for back-compat
  // so existing deployments without it still start (defaults apply).
  { file: "classifier.yaml", key: null, optional: true },
  // lanes.yaml is a FLAT map (lane name -> lane), so the whole file becomes the
  // `lanes` key. Optional: absent -> config.lanes undefined -> gateway falls
  // back to DEFAULT_LANES (principle 6). A present-but-invalid file fails closed.
  { file: "lanes.yaml", key: "lanes", optional: true },
  // policies.yaml IS a `{ policies: [...] }` object — exactly the
  // PoliciesConfigSchema shape — so the whole file becomes the `policies` key.
  // Optional: absent -> the schema default ({ policies: [] }) applies (no-op).
  { file: "policies.yaml", key: "policies", optional: true },
];

type Mutable = Record<string, unknown>;

// A YAML document root must be a mapping for our merge/assign to be meaningful.
// Arrays and scalars are valid YAML but not valid config-file roots here.
function isPlainObject(v: unknown): v is Mutable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

  for (const { file, key, optional } of CONFIG_FILES) {
    const path = join(configDir, file);
    let text: string;
    try {
      text = read(path);
    } catch {
      if (optional) continue; // absent optional file → schema default applies
      throw new ConfigError(`failed to read config file: ${path}`, []);
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch {
      throw new ConfigError(`failed to parse YAML: ${path}`, []);
    }

    // A top-level scalar/array would spread/assign confusingly into the tree and
    // surface as an opaque downstream Zod error. Guard the shape here so the
    // diagnostic names the file and the actual problem (still fail-closed).
    if (parsed !== undefined && parsed !== null && !isPlainObject(parsed)) {
      throw new ConfigError(`${path}: expected a mapping at the top level`, []);
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
