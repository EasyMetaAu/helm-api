import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { expect, type Locator, test } from "@playwright/test";
import { buildServer } from "../src/server.js";

async function expectBorderToken(locator: Locator, token = "--color-border") {
  const colors = await locator.evaluate((element, token) => {
    const reference = document.createElement("span");
    reference.style.borderTopColor = `var(${token})`;
    element.append(reference);
    const expected = getComputedStyle(reference).borderTopColor;
    reference.remove();
    return { actual: getComputedStyle(element).borderTopColor, expected };
  }, token);
  expect(colors.actual).toBe(colors.expected);
}

test("managed provider UI creates, proxies, edits and removes a real gateway connection", async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), "helm-managed-ui-"));
  const config = join(root, "config");
  mkdirSync(config);
  const env = { ...process.env };
  const cwd = process.cwd();
  process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
  let handle: Awaited<ReturnType<typeof buildServer>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls: Array<{ authorization?: string; body: Record<string, unknown>; url?: string }> = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ authorization: req.headers.authorization, body, url: req.url });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "mock",
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  const sockets = new Set<Socket>();
  let proxyCalls = 0;
  const proxy = createServer();
  proxy.on("connect", (req, client, head) => {
    proxyCalls++;
    const target = connect(upstreamPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      client.pipe(target);
      target.pipe(client);
    });
    sockets.add(target);
    sockets.add(client as Socket);
    target.on("error", () => client.destroy());
    client.on("error", () => target.destroy());
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw Error("address");
  const upstreamPort = upstreamAddress.port;
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw Error("proxy address");
  try {
    for (const [name, content] of Object.entries({
      "server.yaml": "host: 127.0.0.1\nport: 8099\nbase_path: /",
      "auth.yaml":
        "require_api_key: true\nbootstrap: {generate_if_missing: false, print_once: false, persist_to: unused}",
      "runtime.yaml":
        "request_timeout_ms: 10000\nrate_limit: {enabled: false, default: {rpm: 0, tpm: 0}}",
      "providers.yaml": "providers: [{name: placeholder, api_key_env: UNUSED_MANAGED_KEY}]",
    }))
      writeFileSync(join(config, name), content);
    Object.assign(process.env, {
      HELM_DATA_DIR: root,
      HELM_ADMIN_USER: "managed-ui",
      HELM_ADMIN_PASSWORD: "test-only-password",
      HELM_OAUTH_ENC_KEY: Buffer.alloc(32, 5).toString("base64"),
      HELM_SIGNALS_DISABLED: "1",
      HELM_PROVIDER_BASE_URL: "",
    });
    handle = await buildServer({ configDir: config, logger: { log: () => {} } });
    const app = handle.app;
    const port = await new Promise<number>((r) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => r(info.port));
    });
    const origin = `http://127.0.0.1:${port}`;
    const headers = {
      Authorization: `Basic ${Buffer.from("managed-ui:test-only-password").toString("base64")}`,
    };
    await page.setExtraHTTPHeaders(headers);
    await page.addInitScript(() =>
      localStorage.setItem("helm_admin_locale", localStorage.getItem("helm_admin_locale") ?? "en"),
    );
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${origin}/admin/providers`);
    await expect(page).toHaveTitle(/Helm/);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await expectBorderToken(page.getByRole("button", { name: "OAuth login", exact: true }));
    await page.getByRole("button", { name: "API key", exact: true }).click();
    await page.getByRole("combobox", { name: "Provider preset", exact: true }).selectOption("kimi");
    await page.getByLabel("API base URL").fill(`http://127.0.0.1:${upstreamPort}/coding/v1`);
    await expectBorderToken(page.getByRole("group", { name: "Key account", exact: true }));
    await page.getByLabel("Account name", { exact: true }).fill("Kimi · 主账号");
    await page.getByLabel("API key", { exact: true }).fill("vendor-synthetic-kimi-key");
    await page.getByLabel("Model alias", { exact: true }).fill("kimi/k3.1-pro[1m]");
    await page.getByLabel("Upstream model ID", { exact: true }).fill("k3.1-pro");
    await page.getByRole("button", { name: "Save provider", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const api = page.getByRole("region", { name: "Key providers", exact: true });
    const row = api.getByRole("row").filter({ hasText: "Kimi · 主账号" });
    await row.getByRole("button", { name: "Manage", exact: true }).click();
    await page.getByLabel("Priority", { exact: true }).fill("10");
    await expectBorderToken(page.getByRole("group", { name: "Account proxy", exact: true }));
    await page.getByLabel("Use a proxy for this account").check();
    await page.getByLabel("Proxy host", { exact: true }).fill("127.0.0.1");
    await page.getByLabel("Proxy port", { exact: true }).fill(String(proxyAddress.port));
    await page.getByLabel("Proxy password", { exact: true }).fill("synthetic-proxy-password");
    await page
      .getByLabel("Default request parameters (JSON)")
      .fill('{"temperature":0.4,"max_tokens":2048}');
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await row.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Run test", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("OK");
    expect(proxyCalls).toBeGreaterThan(0);
    expect(calls.at(-1)).toMatchObject({
      authorization: "Bearer vendor-synthetic-kimi-key",
      url: "/coding/v1/chat/completions",
      body: { model: "k3.1-pro", temperature: 0.4, max_tokens: 2048 },
    });
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    const state = await (
      await page.request.get(`${origin}/admin/api/api-key-pools`, { headers })
    ).json();
    expect(JSON.stringify(state)).not.toContain("synthetic-proxy-password");
    expect(JSON.stringify(state)).not.toContain("vendor-synthetic-kimi-key");
    expect(state.pools.find((p: { id: string }) => p.id === "kimi").accounts[0]).toMatchObject({
      priority: 10,
      proxy: { hasPassword: true },
      parameters: { temperature: 0.4 },
    });
    await page.reload();
    await expect(api.getByRole("row").filter({ hasText: "Kimi · 主账号" })).toContainText("10");
    await expectBorderToken(
      page.getByRole("region", { name: "Key provider connections" }).locator("table").locator(".."),
    );
    const evidence = process.env.HELM_UI_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      await page.evaluate(() => localStorage.setItem("helm_admin_locale", "zh-hans"));
      await page.reload();
      await expect(page.getByRole("button", { name: "添加供应商", exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, "providers-overview.png"), fullPage: true });
      await page.getByRole("button", { name: "添加供应商", exact: true }).click();
      await page.screenshot({ path: join(evidence, "provider-login-options.png") });
      await page.getByRole("button", { name: "API Key", exact: true }).click();
      await page.getByRole("combobox", { name: "供应商预设", exact: true }).selectOption("kimi");
      await page.getByLabel("模型别名", { exact: true }).fill("kimi/k3.1-pro[1m]");
      await page.getByLabel("上游模型 ID", { exact: true }).fill("k3.1-pro");
      await page.screenshot({ path: join(evidence, "provider-connection-form.png") });
      await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
      const account = page.getByRole("row").filter({ hasText: "Kimi · 主账号" });
      await account.getByRole("button", { name: "管理", exact: true }).click();
      await page.screenshot({ path: join(evidence, "provider-account-settings.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: join(evidence, "provider-account-mobile.png") });
      await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
      await page.evaluate(() => localStorage.setItem("helm_admin_locale", "en"));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.reload();
    }
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await page.getByRole("button", { name: "OAuth login", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Delete Kimi", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete Kimi", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await handle?.dispose?.();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
    process.env = env;
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
