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

  it("installs with a frozen lockfile and does not swallow failures in the unit gate", () => {
    expect(raw).toContain("--frozen-lockfile");
    // Scope the "no swallowing" guard to the unit-gate `verify` job: its quality
    // gates must hard-fail. The docker job's teardown step may use
    // `continue-on-error` for cleanup without masking the smoke-test result.
    const verifyJob = raw.slice(raw.indexOf("\n  verify:"), raw.indexOf("\n  docker:"));
    expect(verifyJob).not.toContain("continue-on-error");
    expect(verifyJob).not.toContain("|| true");
  });

  it("has a separate docker job that builds and smoke-tests the gateway image", () => {
    // A dedicated job (independent of the unit-gate `verify` job) that exercises
    // the real Docker image — closes the "Docker not actually built/run in this
    // env" gap by moving build/run verification to CI (docs/10).
    expect(raw).toMatch(/^\s{2}docker:/m);
    expect(raw).toContain("docker build");
    expect(raw).toContain("docker run");
    // Boots with the required provider credential env and hits /healthz.
    expect(raw).toContain("OPENAI_API_KEY");
    expect(raw).toContain("/healthz");
    // Cleans the container up afterwards.
    expect(raw).toContain("docker stop");
  });

  it("keeps the docker job independent so the unit gates run on their own", () => {
    // The docker job must NOT block the four quality gates: no `needs: verify`
    // (or any needs) chaining it onto the unit-gate job.
    const dockerJob = raw.slice(raw.indexOf("\n  docker:"));
    expect(dockerJob).not.toMatch(/needs:/);
  });
});
