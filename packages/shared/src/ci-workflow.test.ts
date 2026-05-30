import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const ciPath = resolve(repoRoot, ".github/workflows/ci.yml");

describe("CI workflow", () => {
  const raw = readFileSync(ciPath, "utf8");

  it("runs the four quality gates: typecheck, lint, test, build", () => {
    for (const gate of ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build"]) {
      expect(raw).toContain(gate);
    }
  });

  it("triggers on pull_request and on push to main", () => {
    expect(raw).toContain("pull_request");
    expect(raw).toMatch(/branches:\s*\[main\]/);
  });

  it("installs with a frozen lockfile and does not swallow failures", () => {
    expect(raw).toContain("--frozen-lockfile");
    expect(raw).not.toContain("continue-on-error");
    expect(raw).not.toContain("|| true");
  });
});
