import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Architecture guard: enforce CLAUDE.md principle 1 — packages/core and
// packages/shared are framework-agnostic and MUST NOT depend on or import any
// web framework (Hono / SvelteKit / Svelte). These tests scan REAL files, not
// hardcoded constants, so the constraint cannot rot silently.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const FORBIDDEN_DEPS = ["hono", "@sveltejs/kit", "svelte", "svelte-kit"];
const FORBIDDEN_IMPORT_RE = /from\s+["'](hono|@sveltejs\/kit|svelte|svelte-kit)["']/;

function readPkg(pkgRelDir: string): Record<string, unknown> {
  const pkgPath = join(repoRoot, pkgRelDir, "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
}

function allDeps(pkg: Record<string, unknown>): string[] {
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
  return [...Object.keys(deps), ...Object.keys(dev)];
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("architecture guard: core/shared are framework-agnostic", () => {
  it("packages/core declares no web-framework dependency", () => {
    const deps = allDeps(readPkg("packages/core"));
    for (const forbidden of FORBIDDEN_DEPS) {
      expect(deps).not.toContain(forbidden);
    }
  });

  it("packages/shared declares no web-framework dependency", () => {
    const deps = allDeps(readPkg("packages/shared"));
    for (const forbidden of FORBIDDEN_DEPS) {
      expect(deps).not.toContain(forbidden);
    }
  });

  it("packages/core source imports no web framework", () => {
    const files = walkTsFiles(join(repoRoot, "packages/core/src"));
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(FORBIDDEN_IMPORT_RE.test(src), `${file} imports a web framework`).toBe(false);
    }
  });

  it("packages/shared source imports no web framework", () => {
    const files = walkTsFiles(join(repoRoot, "packages/shared/src"));
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(FORBIDDEN_IMPORT_RE.test(src), `${file} imports a web framework`).toBe(false);
    }
  });
});
