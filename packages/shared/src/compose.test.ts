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
const exampleEnv = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

describe("docker-compose contract", () => {
  it("allows a local or pinned image without editing the Compose file", () => {
    expect(compose).toContain(`image: \${HELM_IMAGE:-ghcr.io/easymetaau/helm-api:latest}`);
  });

  it("maps the config and data volumes (docs/10)", () => {
    expect(compose).toContain("./config:/app/config");
    expect(compose).toContain("./data:/app/data");
    expect(compose).toMatch(/user: "\$\{HELM_UID:-10001\}:\$\{HELM_GID:-10001\}"/);
  });

  it("passes .env through and publishes HELM_PORT", () => {
    expect(compose).toMatch(/env_file:\s*\n\s*- path: \.env\s*\n\s*required: false/);
    expect(compose).toMatch(/"\$\{HELM_PORT:-8080\}:\$\{HELM_PORT:-8080\}"/);
    expect(compose).toMatch(/HELM_PORT: \$\{HELM_PORT:-8080\}/);
  });

  it("allows browser setup when provider + admin credentials are unset", () => {
    expect(compose).toMatch(/DEEPSEEK_API_KEY:\s*\$\{DEEPSEEK_API_KEY:-\}/);
    expect(compose).toMatch(/HELM_ADMIN_PASSWORD:\s*\$\{HELM_ADMIN_PASSWORD:-\}/);
    expect(compose).not.toMatch(/DEEPSEEK_API_KEY:\s*\$\{DEEPSEEK_API_KEY:\?/);
    expect(compose).not.toMatch(/HELM_ADMIN_PASSWORD:\s*\$\{HELM_ADMIN_PASSWORD:\?/);
  });

  it("contains no plaintext secrets", () => {
    expect(compose).not.toContain("sk-");
    expect(compose).not.toMatch(/PASSWORD:\s*["']?[a-zA-Z0-9]{6,}["']?\s*$/m);
  });

  it("health-checks /healthz consistently with the image", () => {
    expect(compose).toContain("healthcheck");
    expect(compose).toContain("/healthz");
  });

  it("gives graceful shutdown enough time to drain maintenance and queued writes", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker Compose interpolation is literal.
    expect(compose).toContain("stop_grace_period: ${HELM_STOP_GRACE_PERIOD:-30m}");
  });

  it("declares a single service (no extra Redis/DB containers in MVP)", () => {
    const serviceCount = (compose.match(/^\s{2}\w[\w-]*:/gm) ?? []).length;
    expect(serviceCount).toBe(1);
  });

  it("keeps copied examples fail-closed instead of accepting placeholder secrets", () => {
    expect(exampleEnv).toMatch(/^HELM_ADMIN_PASSWORD=\s*$/m);
    expect(exampleEnv).toMatch(/^DEEPSEEK_API_KEY=\s*$/m);
    expect(exampleEnv).not.toMatch(/^\w+_API_KEY=(?:sk-|\.\.\.)/m);
  });

  it("provides a source start command that loads .env with Node 22", () => {
    expect(rootPackage.scripts?.start).toBe(
      "node --env-file-if-exists=.env apps/gateway/dist/index.js",
    );
  });

  it("ships a beginner initializer", () => {
    const quickstart = readFileSync(resolve(repoRoot, "scripts/quickstart.sh"), "utf8");
    expect(quickstart).toContain("docker compose up -d --wait");
    expect(quickstart).toContain("HELM_UID=$(id -u)");
    expect(quickstart).toContain("HELM_GID=$(id -g)");
  });
});
