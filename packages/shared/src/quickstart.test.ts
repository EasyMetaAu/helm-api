import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("quickstart", () => {
  it("defaults to the browser setup path and starts Compose without secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "helm-quickstart-"));
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const dockerLog = join(root, "docker.log");
    mkdirSync(scripts);
    mkdirSync(bin);
    cpSync(resolve(repoRoot, "scripts/quickstart.sh"), join(scripts, "quickstart.sh"));
    writeFileSync(
      join(bin, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\nif [ "$*" = "compose up -d --wait" ]; then mkdir -p data; printf "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\\n" > data/helm-setup-token; fi\n',
    );
    chmodSync(join(bin, "docker"), 0o755);

    const env = { ...process.env, DOCKER_LOG: dockerLog, PATH: `${bin}:${process.env.PATH}` };
    const output = execFileSync("bash", [join(scripts, "quickstart.sh")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();

    const first = readFileSync(join(root, ".env"), "utf8");
    expect(first).toMatch(/^HELM_UID=\d+$/m);
    expect(first).toMatch(/^HELM_GID=\d+$/m);
    expect(first).toMatch(/^HELM_PORT=8080$/m);
    expect(first).not.toContain("HELM_ADMIN_PASSWORD");
    expect(first).not.toContain("DEEPSEEK_API_KEY");
    expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(dockerLog, "utf8")).toContain("compose up -d --wait");
    expect(output).toContain(
      "http://127.0.0.1:8080/setup#token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(output).not.toContain("Get the one-time token");

    execFileSync("bash", [join(scripts, "quickstart.sh")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(first);
  });

  it("keeps a CLI path that writes generated admin/OAuth credentials and an optional key", () => {
    const root = mkdtempSync(join(tmpdir(), "helm-quickstart-cli-"));
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const dockerLog = join(root, "docker.log");
    mkdirSync(scripts);
    mkdirSync(bin);
    cpSync(resolve(repoRoot, "scripts/quickstart.sh"), join(scripts, "quickstart.sh"));
    writeFileSync(join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n');
    chmodSync(join(bin, "docker"), 0o755);

    execFileSync("bash", [join(scripts, "quickstart.sh"), "--cli"], {
      env: { ...process.env, DOCKER_LOG: dockerLog, PATH: `${bin}:${process.env.PATH}` },
      input: "sk-test-only\n",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const configured = readFileSync(join(root, ".env"), "utf8");
    expect(configured).toMatch(/^HELM_ADMIN_USER=admin$/m);
    expect(configured).toMatch(/^HELM_ADMIN_PASSWORD=[a-f0-9]{32}$/m);
    expect(configured).toMatch(/^HELM_OAUTH_ENC_KEY=[A-Za-z0-9+/=]+$/m);
    expect(configured).toMatch(/^DEEPSEEK_API_KEY=sk-test-only$/m);
    expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(dockerLog, "utf8")).toContain("compose up -d --wait");
  });
});
