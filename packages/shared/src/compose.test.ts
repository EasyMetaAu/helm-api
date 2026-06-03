import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docker compose cannot run in this sandbox; the compose contract (volumes,
// ports, env injection, fail-closed secrets, healthcheck) is pinned by static
// assertions. Real `compose up` -> healthy is verified in Docker-capable CI.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");

describe("docker-compose contract", () => {
  it("maps the config and data volumes (docs/10)", () => {
    expect(compose).toContain("./config:/app/config");
    expect(compose).toContain("./data:/app/data");
  });

  it("publishes port 8080", () => {
    expect(compose).toContain("8080:8080");
  });

  it("injects provider + admin credentials via env (fail-closed when unset)", () => {
    expect(compose).toMatch(/DEEPSEEK_API_KEY:\s*\$\{DEEPSEEK_API_KEY:\?/);
    expect(compose).toMatch(/HELM_ADMIN_PASSWORD:\s*\$\{HELM_ADMIN_PASSWORD:\?/);
  });

  it("contains no plaintext secrets", () => {
    expect(compose).not.toContain("sk-");
    expect(compose).not.toMatch(/PASSWORD:\s*["']?[a-zA-Z0-9]{6,}["']?\s*$/m);
  });

  it("health-checks /healthz consistently with the image", () => {
    expect(compose).toContain("healthcheck");
    expect(compose).toContain("/healthz");
  });

  it("declares a single service (no extra Redis/DB containers in MVP)", () => {
    const serviceCount = (compose.match(/^\s{2}\w[\w-]*:/gm) ?? []).length;
    expect(serviceCount).toBe(1);
  });
});
