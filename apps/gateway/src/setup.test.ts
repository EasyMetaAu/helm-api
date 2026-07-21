import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerHandle } from "./server.js";
import {
  createSetupServer,
  loadManagedEnvironment,
  managedEnvironmentPath,
  type SetupProvider,
  setupRequired,
} from "./setup.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "helm-setup-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const provider: SetupProvider = {
  id: "DEEPSEEK_API_KEY",
  label: "DeepSeek",
  envName: "DEEPSEEK_API_KEY",
  configured: false,
};

function fakeHandle(): ServerHandle {
  return {
    app: { fetch: vi.fn() } as unknown as ServerHandle["app"],
    host: "127.0.0.1",
    port: 8080,
  };
}

function auth(token: string): Record<string, string> {
  return { "x-helm-setup-token": token, "content-type": "application/json" };
}

describe("setupRequired", () => {
  it("enters setup only when admin credentials are absent", () => {
    expect(setupRequired({})).toBe(true);
    expect(setupRequired({ HELM_ADMIN_USER: "admin", HELM_ADMIN_PASSWORD: "secret" })).toBe(false);
    expect(setupRequired({ HELM_ADMIN_USER: "admin", HELM_ADMIN_PASSWORD: "" })).toBe(true);
  });

  it("preserves an explicitly disabled headless admin surface", () => {
    expect(setupRequired({ HELM_ADMIN_ENABLED: "false" })).toBe(false);
    expect(setupRequired({ HELM_SETUP_DISABLED: "1" })).toBe(false);
  });
});

describe("managed environment", () => {
  it("loads only allowed values and keeps a non-empty external env override", async () => {
    const dataDir = await tempDir();
    await writeFile(
      managedEnvironmentPath(dataDir),
      JSON.stringify({
        HELM_ADMIN_ENABLED: "true",
        HELM_ADMIN_USER: "managed",
        HELM_ADMIN_PASSWORD: "managed-password",
        HELM_OAUTH_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
        DEEPSEEK_API_KEY: "managed-key",
      }),
      { mode: 0o600 },
    );
    const env: Record<string, string | undefined> = { HELM_ADMIN_USER: "external" };

    expect(
      await loadManagedEnvironment({
        dataDir,
        env,
        allowedProviderEnvNames: ["DEEPSEEK_API_KEY"],
      }),
    ).toBe(true);
    expect(env.HELM_ADMIN_USER).toBe("external");
    expect(env.HELM_ADMIN_PASSWORD).toBe("managed-password");
    expect(env.DEEPSEEK_API_KEY).toBe("managed-key");
  });

  it("fails closed for a group/world-readable secret file", async () => {
    const dataDir = await tempDir();
    const path = managedEnvironmentPath(dataDir);
    await writeFile(path, "{}", { mode: 0o600 });
    await chmod(path, 0o644);

    await expect(
      loadManagedEnvironment({ dataDir, env: {}, allowedProviderEnvNames: [] }),
    ).rejects.toThrow(/0600/);
  });
});

describe("setup server", () => {
  it("exposes only setup and readiness surfaces before initialization", async () => {
    const dataDir = await tempDir();
    const log = vi.fn();
    const setup = await createSetupServer({
      dataDir,
      host: "0.0.0.0",
      port: 8080,
      providers: [provider],
      env: {},
      testProvider: vi.fn(),
      buildFullServer: vi.fn(),
      activate: vi.fn(),
      readRootKey: vi.fn(),
      log,
    });

    expect((await setup.handle.app.request("/healthz")).status).toBe(200);
    expect(await (await setup.handle.app.request("/healthz")).json()).toMatchObject({
      status: "setup_required",
      ready: true,
    });
    expect((await setup.handle.app.request("/setup")).status).toBe(200);
    const html = await (await setup.handle.app.request("/setup")).text();
    expect(html).toContain("Set up Helm");
    expect(html).not.toContain('<label for="token">');
    expect(html.indexOf("Administrator")).toBeLessThan(html.indexOf("Provider access"));
    expect(html).toContain("location.hash");
    expect(html).toContain("Open the complete setup link printed by Docker");
    expect(html).toContain("Administrator API token");
    expect(log).toHaveBeenCalledWith(
      `Open http://127.0.0.1:8080/setup#token=${setup.token} to finish setup.`,
    );
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script ?? "")).not.toThrow();
    expect((await setup.handle.app.request("/v1/models")).status).toBe(404);
    expect((await setup.handle.app.request("/admin/api/keys")).status).toBe(404);
  });

  it("features only OpenRouter and DeepSeek, links key registration, and offers subscriptions", async () => {
    const dataDir = await tempDir();
    const setup = await createSetupServer({
      dataDir,
      host: "0.0.0.0",
      port: 8080,
      providers: [
        provider,
        {
          id: "ZENMUX_API_KEY",
          label: "zenmux",
          envName: "ZENMUX_API_KEY",
          configured: false,
        },
        {
          id: "OPENROUTER_API_KEY",
          label: "openrouter",
          envName: "OPENROUTER_API_KEY",
          configured: false,
        },
      ],
      env: {},
      testProvider: vi.fn(),
      buildFullServer: vi.fn(),
      activate: vi.fn(),
      readRootKey: vi.fn(),
      log: vi.fn(),
    });

    const html = await (await setup.handle.app.request("/setup")).text();
    expect(html).toContain("All API keys are optional.");
    expect(html).toContain("https://openrouter.ai/settings/keys");
    expect(html).toContain("https://platform.deepseek.com/api_keys");
    expect(html).toContain('id="other-providers"');
    expect(html).toContain("Other API key providers (optional)");
    expect(html).toContain("Bind a subscription");
    expect(html).toContain("ChatGPT Plus/Pro");
  });

  it("rejects an invalid setup token without testing or persisting a key", async () => {
    const dataDir = await tempDir();
    const testProvider = vi.fn();
    const setup = await createSetupServer({
      dataDir,
      host: "0.0.0.0",
      port: 8080,
      providers: [provider],
      env: {},
      testProvider,
      buildFullServer: vi.fn(),
      activate: vi.fn(),
      readRootKey: vi.fn(),
      log: vi.fn(),
    });

    const response = await setup.handle.app.request("/setup/api/test-provider", {
      method: "POST",
      headers: auth("wrong"),
      body: JSON.stringify({ providerId: provider.id, apiKey: "sk-secret" }),
    });
    expect(response.status).toBe(401);
    expect(testProvider).not.toHaveBeenCalled();
  });

  it("requires each newly supplied static key to pass its live test", async () => {
    const dataDir = await tempDir();
    const setup = await createSetupServer({
      dataDir,
      host: "0.0.0.0",
      port: 8080,
      providers: [provider],
      env: {},
      testProvider: vi.fn(),
      buildFullServer: vi.fn(),
      activate: vi.fn(),
      readRootKey: vi.fn(),
      log: vi.fn(),
    });

    const emptyTest = await setup.handle.app.request("/setup/api/test-provider", {
      method: "POST",
      headers: auth(setup.token),
      body: JSON.stringify({ providerId: provider.id, apiKey: "" }),
    });
    expect(emptyTest.status).toBe(400);
    expect(await emptyTest.json()).toMatchObject({ message: "Enter an API key before testing." });

    const response = await setup.handle.app.request("/setup/api/complete", {
      method: "POST",
      headers: auth(setup.token),
      body: JSON.stringify({
        username: "admin",
        password: "a secure password",
        providerKeys: { DEEPSEEK_API_KEY: "sk-untested" },
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "provider_test_required" });
  });

  it("tests, persists, activates, and returns the one-time root key", async () => {
    const dataDir = await tempDir();
    const env: Record<string, string | undefined> = {};
    const full = fakeHandle();
    const testProvider = vi.fn().mockResolvedValue(undefined);
    const buildFullServer = vi.fn().mockResolvedValue(full);
    const activate = vi.fn();
    const setup = await createSetupServer({
      dataDir,
      host: "0.0.0.0",
      port: 8080,
      providers: [provider],
      env,
      testProvider,
      buildFullServer,
      activate,
      readRootKey: vi.fn().mockResolvedValue("helm_live_root"),
      log: vi.fn(),
    });

    const tested = await setup.handle.app.request("/setup/api/test-provider", {
      method: "POST",
      headers: auth(setup.token),
      body: JSON.stringify({ providerId: provider.id, apiKey: "sk-tested" }),
    });
    expect(tested.status).toBe(200);
    expect(testProvider).toHaveBeenCalledWith(provider.id, "sk-tested");

    const completed = await setup.handle.app.request("/setup/api/complete", {
      method: "POST",
      headers: auth(setup.token),
      body: JSON.stringify({
        username: "owner",
        password: "a secure password",
        providerKeys: { DEEPSEEK_API_KEY: "sk-tested" },
      }),
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      ok: true,
      apiKey: "helm_live_root",
      adminPath: "/admin/providers",
    });
    expect(buildFullServer).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(full);
    expect(env.HELM_ADMIN_USER).toBe("owner");
    expect(env.HELM_ADMIN_PASSWORD).toBe("a secure password");
    expect(env.DEEPSEEK_API_KEY).toBe("sk-tested");
    expect(Buffer.from(env.HELM_OAUTH_ENC_KEY ?? "", "base64")).toHaveLength(32);

    const persisted = JSON.parse(await readFile(managedEnvironmentPath(dataDir), "utf8")) as Record<
      string,
      string
    >;
    expect(persisted).toMatchObject({
      HELM_ADMIN_ENABLED: "true",
      HELM_ADMIN_USER: "owner",
      HELM_ADMIN_PASSWORD: "a secure password",
      DEEPSEEK_API_KEY: "sk-tested",
    });
    expect((await stat(managedEnvironmentPath(dataDir))).mode & 0o777).toBe(0o600);
    await expect(stat(join(dataDir, "helm-setup-token"))).rejects.toThrow();
  });

  it("allows OAuth-only initialization without any static provider key", async () => {
    const dataDir = await tempDir();
    const full = fakeHandle();
    const buildFullServer = vi.fn().mockResolvedValue(full);
    const activate = vi.fn();
    const setup = await createSetupServer({
      dataDir,
      host: "0.0.0.0",
      port: 8080,
      providers: [provider],
      env: {},
      testProvider: vi.fn(),
      buildFullServer,
      activate,
      readRootKey: vi.fn().mockResolvedValue(null),
      log: vi.fn(),
    });

    const completed = await setup.handle.app.request("/setup/api/complete", {
      method: "POST",
      headers: auth(setup.token),
      body: JSON.stringify({
        username: "admin",
        password: "a secure password",
        providerKeys: {},
      }),
    });
    expect(completed.status).toBe(200);
    expect(buildFullServer).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(full);
  });

  it("preserves an externally managed admin password while collecting the missing username", async () => {
    const dataDir = await tempDir();
    const env: Record<string, string | undefined> = {
      HELM_ADMIN_PASSWORD: "externally-managed-password",
    };
    const full = fakeHandle();
    const buildFullServer = vi.fn().mockResolvedValue(full);
    const setup = await createSetupServer({
      dataDir,
      host: "0.0.0.0",
      port: 8080,
      providers: [provider],
      env,
      testProvider: vi.fn(),
      buildFullServer,
      activate: vi.fn(),
      readRootKey: vi.fn().mockResolvedValue("helm_live_root"),
      log: vi.fn(),
    });

    const html = await (await setup.handle.app.request("/setup")).text();
    expect(html).toContain("const passwordConfigured=true");

    const completed = await setup.handle.app.request("/setup/api/complete", {
      method: "POST",
      headers: auth(setup.token),
      body: JSON.stringify({ username: "admin", password: "", providerKeys: {} }),
    });

    expect(completed.status).toBe(200);
    expect(buildFullServer).toHaveBeenCalledOnce();
    expect(env.HELM_ADMIN_USER).toBe("admin");
    expect(env.HELM_ADMIN_PASSWORD).toBe("externally-managed-password");
    const persisted = JSON.parse(await readFile(managedEnvironmentPath(dataDir), "utf8")) as Record<
      string,
      string
    >;
    expect(persisted.HELM_ADMIN_USER).toBe("admin");
    expect(persisted).not.toHaveProperty("HELM_ADMIN_PASSWORD");
  });
});
