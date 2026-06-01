import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CatalogEntry, GeneratedCatalogSchema } from "@helm/shared";
import { parse as parseYaml } from "yaml";
import { CatalogError, loadCatalog } from "./index.js";

// Runtime catalog file-loader: composes the checked-in GENERATED catalog (a
// supply-chain artifact synced via `pnpm sync:catalog`, NEVER fetched at runtime)
// with the two manual OVERRIDE yamls (capabilities.yaml / pricing.yaml). The pure
// merge lives in `loadCatalog` (IO-free); this thin module only does the file IO
// (mirrors config/loader.ts — core may read files, it just may not import a web
// framework, principle 1). Manual entries win per-field (CLAUDE.md implementation conventions); an
// invalid override fails closed (principle 2). Capability metadata flows from here
// into the routing pipeline's capability filter — replacing the empty Map that
// made the filter fail-open-skip every candidate.

// The generated catalog sits beside this module under generated/catalog.json. It
// is resolved relative to import.meta.url so it is found whether core runs from
// src (tsx/tests) or from a deployed copy (the published package keeps the src
// tree as its entry point — see packages/core/package.json `exports`).
const GENERATED_CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "generated",
  "catalog.json",
);

export interface LoadRuntimeCatalogOptions {
  /** Directory holding capabilities.yaml / pricing.yaml (defaults to ./config). */
  configDir?: string;
  /** Injected reader (tests). Defaults to fs.readFileSync(utf8). For the OPTIONAL
   *  override yamls ONLY an ENOENT throw means "file absent" (schema default
   *  applies); every other error (EACCES/EIO/broken-symlink/wrong-CWD) re-throws
   *  as a CatalogError, fail-closed (principle 2). The REQUIRED generated catalog
   *  re-throws on ANY read failure. */
  readFile?: (path: string) => string;
  /** Optional structured logger; defaults to a no-op so core stays framework-free.
   *  Emits 'catalog.override_absent' {file} when an override resolves absent so an
   *  accidental wrong-CWD wipe of the override layer is observable. */
  log?: (level: "warn" | "info", msg: string, fields?: Record<string, unknown>) => void;
}

// Narrow a thrown value to its `code` (Node fs errors carry e.g. 'ENOENT').
function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

// Read + validate the generated catalog (fail-closed: a missing/corrupt
// supply-chain artifact is a build defect, never silently empty).
function readGenerated(read: (path: string) => string): unknown {
  let text: string;
  try {
    text = read(GENERATED_CATALOG_PATH);
  } catch {
    throw new CatalogError(`failed to read generated catalog: ${GENERATED_CATALOG_PATH}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CatalogError(`failed to parse generated catalog JSON: ${GENERATED_CATALOG_PATH}`);
  }
  const result = GeneratedCatalogSchema.safeParse(parsed);
  if (!result.success) {
    throw new CatalogError("invalid generated catalog", result.error.issues);
  }
  return result.data;
}

// Read an OPTIONAL override yaml: an ENOENT read failure → undefined so the merge
// applies the schema default ({}). EVERY other read error (EACCES/EIO/broken
// symlink/wrong CWD) re-throws as a CatalogError — swallowing those would
// silently wipe relay-model capabilities+pricing (they live ONLY in this override
// layer), a principle-2 fail-closed inversion. A present-but-broken yaml STILL
// fails closed inside loadCatalog's per-field validation.
function readOverride(read: (path: string) => string, path: string): unknown {
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return undefined;
    throw new CatalogError(`failed to read override: ${path} (${errCode(err) ?? "unknown error"})`);
  }
  try {
    return parseYaml(text);
  } catch {
    throw new CatalogError(`failed to parse YAML: ${path}`);
  }
}

export function loadRuntimeCatalog(
  opts: LoadRuntimeCatalogOptions = {},
): Map<string, CatalogEntry> {
  const configDir = opts.configDir ?? "./config";
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const log = opts.log ?? (() => {});

  const generated = readGenerated(read);

  // An override resolving to undefined means the file is genuinely absent
  // (ENOENT) — log it so an accidental wrong-CWD wipe of the override layer is
  // observable rather than silently fail-open.
  const capabilitiesPath = join(configDir, "capabilities.yaml");
  const pricingPath = join(configDir, "pricing.yaml");
  const capabilitiesOverride = readOverride(read, capabilitiesPath);
  if (capabilitiesOverride === undefined) {
    log("info", "catalog.override_absent", { file: capabilitiesPath });
  }
  const pricingOverride = readOverride(read, pricingPath);
  if (pricingOverride === undefined) {
    log("info", "catalog.override_absent", { file: pricingPath });
  }

  return loadCatalog({
    // GeneratedCatalogSchema already validated the shape in readGenerated.
    generated: generated as Parameters<typeof loadCatalog>[0]["generated"],
    capabilitiesOverride,
    pricingOverride,
  });
}
