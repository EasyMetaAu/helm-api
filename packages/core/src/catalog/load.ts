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
// framework, principle 1). Manual entries win per-field (CLAUDE.md 实现约定); an
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
  /** Injected reader (tests). Defaults to fs.readFileSync(utf8). A throw is
   *  treated as "file absent" for the OPTIONAL override yamls (schema default
   *  applies); the REQUIRED generated catalog re-throws as a CatalogError. */
  readFile?: (path: string) => string;
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

// Read an OPTIONAL override yaml: absent (read throws) → undefined so the merge
// applies the schema default ({}). A present-but-broken yaml STILL fails closed
// inside loadCatalog's per-field validation (principle 2).
function readOverride(read: (path: string) => string, path: string): unknown {
  let text: string;
  try {
    text = read(path);
  } catch {
    return undefined;
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

  const generated = readGenerated(read);
  const capabilitiesOverride = readOverride(read, join(configDir, "capabilities.yaml"));
  const pricingOverride = readOverride(read, join(configDir, "pricing.yaml"));

  return loadCatalog({
    // GeneratedCatalogSchema already validated the shape in readGenerated.
    generated: generated as Parameters<typeof loadCatalog>[0]["generated"],
    capabilitiesOverride,
    pricingOverride,
  });
}
