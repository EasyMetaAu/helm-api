import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Docker can't be built in this sandbox, so the Dockerfile's contract is pinned
// by static assertions (the "executable spec" approach from the task). Build /
// runtime behavior is exercised by CI where Docker is available.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");

describe("Dockerfile contract", () => {
  it("is a multi-stage build (builder + runtime)", () => {
    expect(dockerfile).toMatch(/AS builder/);
    expect(dockerfile).toMatch(/AS runtime/);
  });

  it("runs as a non-root user (uid 10001)", () => {
    expect(dockerfile).toMatch(/--uid 10001/);
    expect(dockerfile).toMatch(/USER helm/);
  });

  it("exposes 8080 and health-checks /healthz", () => {
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/healthz");
  });

  it("installs with a frozen lockfile", () => {
    expect(dockerfile).toContain("--frozen-lockfile");
  });

  it("creates the config and data mount points owned by the runtime user", () => {
    expect(dockerfile).toMatch(/mkdir -p \/app\/config \/app\/data/);
    expect(dockerfile).toMatch(/chown -R helm:helm \/app/);
  });

  it("embeds no plaintext credentials", () => {
    expect(dockerfile).not.toMatch(/OPENAI_API_KEY\s*=/);
    expect(dockerfile).not.toMatch(/HELM_ADMIN_PASSWORD\s*=/);
    expect(dockerfile).not.toContain("sk-");
  });

  it("ignores secrets and build noise via .dockerignore", () => {
    const dockerignore = readFileSync(resolve(repoRoot, ".dockerignore"), "utf8");
    expect(dockerignore).toContain(".env");
    expect(dockerignore).toContain("node_modules");
    expect(dockerignore).toContain("data");
  });
});
