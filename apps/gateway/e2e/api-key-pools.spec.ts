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
      "providers:\n  - name: openai\n    type: openai\n    base_url: http://127.0.0.1:8181/v1\n    api_key_pool: { id: openai }\n    models:\n      - { alias: 'openai/gpt-4o-mini', provider_model: gpt-4o-mini }\n",
    );
    Object.assign(process.env, {
      HELM_DATA_DIR: root,
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
    await page.addInitScript(() => localStorage.setItem("locale", "en"));
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
    let row = section.getByRole("row").filter({ hasText: "API 1" });
    await row.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(row.getByText("Paused manually")).toBeVisible();
    await expect(row.getByRole("button", { name: "Try recovery" })).toBeDisabled();
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Primary account");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    row = section.getByRole("row").filter({ hasText: "Primary account" });
    await expect(row).toBeVisible();
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
    const evidenceDir = process.env.HELM_UI_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({
        path: join(evidenceDir, "api-key-pools-desktop.png"),
        fullPage: false,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(section.getByRole("button", { name: "Add API keys" })).toBeVisible();
      await page.screenshot({
        path: join(evidenceDir, "api-key-pools-mobile.png"),
        fullPage: false,
      });
    }
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(section.getByText("Primary account", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await handle?.dispose?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    process.env = env;
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
