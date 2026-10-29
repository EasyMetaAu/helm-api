import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { expect, test } from "@playwright/test";
import { buildServer } from "../src/server.js";

// A private gateway/store keeps credential CRUD from changing the shared e2e server.
test("API key provider import, pause, edit and delete through the real admin UI", async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), "helm-api-key-ui-"));
  const config = join(root, "config");
  mkdirSync(config);
  const env = { ...process.env };
  const originalCwd = process.cwd();
  process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
  let handle: Awaited<ReturnType<typeof buildServer>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    writeFileSync(join(config, "server.yaml"), "host: 127.0.0.1\nport: 8099\nbase_path: /\n");
    writeFileSync(
      join(config, "auth.yaml"),
      "require_api_key: true\nbootstrap:\n  generate_if_missing: false\n  print_once: false\n  persist_to: unused-key-file\n",
    );
    writeFileSync(
      join(config, "runtime.yaml"),
      "request_timeout_ms: 10000\nrate_limit:\n  enabled: false\n  default: { rpm: 0, tpm: 0 }\n",
    );
    writeFileSync(
      join(config, "providers.yaml"),
      "providers:\n  - name: openai\n    type: openai\n    base_url: http://127.0.0.1:8181\n    api_key_pool: { id: openai }\n    models:\n      - { alias: 'openai/gpt-4o-mini', provider_model: gpt-4o-mini }\n",
    );
    Object.assign(process.env, {
      HELM_DATA_DIR: root,
      HELM_PROVIDER_BASE_URL: "http://127.0.0.1:8181",
      HELM_ADMIN_ENABLED: "true",
      HELM_ADMIN_USER: "pool-ui",
      HELM_ADMIN_PASSWORD: "test-only-password",
      HELM_OAUTH_ENC_KEY: Buffer.alloc(32, 9).toString("base64"),
      HELM_SIGNALS_DISABLED: "1",
    });
    handle = await buildServer({ configDir: config, logger: { log: () => {} } });
    const handleApp = handle.app;
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: handleApp.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
        resolve(info.port),
      );
    });
    const url = `http://127.0.0.1:${port}/admin/providers`;
    const adminHeaders = {
      Authorization: `Basic ${Buffer.from("pool-ui:test-only-password").toString("base64")}`,
    };
    await page.setExtraHTTPHeaders(adminHeaders);
    await page.addInitScript(() => {
      if (!localStorage.getItem("helm_admin_locale"))
        localStorage.setItem("helm_admin_locale", "en");
    });
    await page.goto(url);
    await expect(page).toHaveURL(url);
    await expect(page).toHaveTitle(/Helm/i);
    const section = page.getByRole("region", { name: "API key providers", exact: true });
    await expect(section.getByRole("button", { name: "Add API keys" })).toBeEnabled();
    await section.getByRole("button", { name: "Add API keys" }).click();
    await page
      .getByLabel("API keys (one per line)")
      .fill("sk-proj-ui-test-first\nsk-proj-ui-test-second");
    await page.getByRole("button", { name: "Save API keys" }).click();
    await expect(section.getByText("API 1", { exact: true })).toBeVisible();
    await expect(section.getByText("API 2", { exact: true })).toBeVisible();
    for (const name of ["API 1", "API 2"]) {
      const accountRow = section.getByRole("row").filter({ hasText: name });
      await accountRow.getByRole("button", { name: "Test", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Test API key" });
      await expect(dialog.getByText(name, { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Run test", exact: true }).click();
      await expect(dialog.getByText("Test passed", { exact: true })).toBeVisible();
      await expect(dialog.getByText("hello from mock", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    }
    let row = section.getByRole("row").filter({ hasText: "API 1" });
    await expect(row.getByRole("button", { name: "Delete", exact: true })).not.toBeVisible();
    await row.locator("summary").click();
    await row.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(row.getByText("Paused manually")).toBeVisible();
    await expect(row.getByRole("button", { name: "Try recovery" })).toHaveCount(0);
    await row.getByRole("button", { name: "Manage", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Primary account");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    row = section.getByRole("row").filter({ hasText: "Primary account" });
    await expect(row).toBeVisible();
    await row.locator("summary").click();
    await row.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(row.getByText("Available", { exact: true })).toBeVisible();
    await section.getByLabel("API key rotation strategy").selectOption("manual_priority");
    await expect(section.getByLabel("API key rotation strategy")).toHaveValue("manual_priority");
    const readback = await page.request.get(`http://127.0.0.1:${port}/admin/api/api-key-pools`, {
      headers: adminHeaders,
    });
    const text = await readback.text();
    expect(text).not.toContain("sk-proj-ui-test");
    expect(JSON.parse(text).pools[0].accounts).toHaveLength(2);
    expect(JSON.parse(text).pools[0].strategy).toBe("manual_priority");
    await row.locator("summary").click();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(section.getByText("Primary account", { exact: true })).toHaveCount(0);
    const evidenceDir = process.env.HELM_UI_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      // Synthetic presentation fixtures; no production account data in screenshots.
      await page.route("**/admin/api/api-key-pools", (route) =>
        route.fulfill({
          json: {
            pools: [
              {
                id: "openai",
                configured: true,
                timezone: "Asia/Shanghai",
                strategy: "round_robin",
                models: ["gpt-6-luna"],
                accounts: Array.from({ length: 4 }, (_, i) => ({
                  id: `sample-${i}`,
                  name: `OpenAI ${i + 1}`,
                  mask: "••••demo",
                  enabled: true,
                  priority: 50,
                  models: null,
                  state: "ready",
                  reason: null,
                  nextRetryAt: null,
                  probeUntil: null,
                  deniedModels: [],
                })),
                usage: Array.from({ length: 4 }, (_, i) => ({
                  account: `sample-${i}`,
                  requests: 120 + i * 10,
                  tokens: 42000 + i * 1000,
                  costUsd: i === 0 ? 0.000003 : 0.024 + i * 0.003,
                })),
              },
            ],
          },
        }),
      );
      const providerId = "openai-codex";
      await page.route("**/admin/api/oauth/overview*", (route) =>
        route.fulfill({
          json: {
            configured: true,
            selectionStrategy: "balanced",
            providers: [
              {
                id: providerId,
                name: "ChatGPT Plus/Pro (Codex)",
                flow: "device_code",
                accounts: ["Team account", "Personal account"].map((account) => ({
                  account,
                  healthy: true,
                  expiresAt: null,
                  updatedAt: Date.now(),
                  priority: 50,
                  schedulable: true,
                  fastMode: false,
                  models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra"],
                })),
              },
            ],
            usage: ["Team account", "Personal account"].map((account) => ({
              providerId,
              account,
              requests: 156,
              tokens: 20300000,
              costUsd: 25.27,
              rpm: 3.87,
            })),
            quota: [],
            refresh: {
              state: "idle",
              jobId: null,
              requestedAt: null,
              startedAt: null,
              finishedAt: null,
              lastSuccessAt: null,
              nextAllowedAt: null,
              error: null,
            },
          },
        }),
      );
      await page.evaluate(() => localStorage.setItem("helm_admin_locale", "zh-hans"));
      await page.reload();
      await expect(page.getByRole("heading", { name: "提供商", exact: true })).toBeVisible();
      await expect(page.getByText("OpenAI 4", { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1440, height: 1100 });
      const lastAccount = page.getByRole("row").filter({ hasText: "OpenAI 4" });
      await lastAccount.locator("summary").click();
      await expect(lastAccount.getByRole("button", { name: "删除", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        lastAccount.getByRole("button", { name: "删除", exact: true }),
      ).not.toBeVisible();
      await page.screenshot({
        path: join(evidenceDir, "api-key-pools-desktop.png"),
        fullPage: false,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: join(evidenceDir, "api-key-pools-mobile.png"),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await handle?.dispose?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    process.env = env;
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
