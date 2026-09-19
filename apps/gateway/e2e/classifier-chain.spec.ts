import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, basicHeader } from "./fixtures/admin.js";

const admin = { Authorization: basicHeader(ADMIN_USER, ADMIN_PASSWORD) };
const mock = "http://127.0.0.1:8181";
const candidates = [
  { type: "jev", model: "typesafe/jev-1.13", timeout_ms: 100, min_confidence: 0.6 },
  { type: "chat", model: "economy", timeout_ms: 3000, min_confidence: 0 },
];
test.describe("classifier chain", () => {
  let baseline: Record<string, unknown>;
  test.beforeAll(async ({ request }) => {
    const res = await request.get("/admin/api/classifier", { headers: admin });
    expect(res.ok()).toBe(true);
    baseline = await res.json();
  });
  test.afterEach(async ({ request }) => {
    expect(
      (await request.put("/admin/api/classifier", { headers: admin, data: baseline })).ok(),
    ).toBe(true);
  });
  test("Jev success, cache, failure, low confidence, timeout and reversed order", async ({
    request,
  }) => {
    const config = {
      ...baseline,
      rules: { ...(baseline.rules as object), enabled: false },
      eval: {
        ...(baseline.eval as object),
        enabled: true,
        chain: candidates,
        outer_timeout_ms: 5000,
      },
    };
    expect(
      (await request.put("/admin/api/classifier", { headers: admin, data: config })).ok(),
    ).toBe(true);
    await request.post(`${mock}/__eval_reset`);
    const route = (content: string) =>
      request.post("/v1/chat/completions", {
        headers: { Authorization: "Bearer helm_live_e2e_testkey" },
        data: { model: "auto", messages: [{ role: "user", content }], stream: false },
      });
    const first = await route("中文分类测试 __JEV_OK__");
    expect(first.status()).toBe(200);
    expect(first.headers()["x-helm-decided-by"]).toBe("eval");
    expect((await (await request.get(`${mock}/__eval_count`)).json()).count).toBe(0);
    expect((await (await request.get(`${mock}/__jev_count`)).json()).count).toBe(1);
    expect((await route("中文分类测试 __JEV_OK__")).headers()["x-helm-eval-cache-hit"]).toBe(
      "true",
    );
    for (const marker of ["__JEV_ERROR__", "__JEV_LOW__", "__JEV_SLOW__", "__JEV_BAD__"]) {
      const res = await route(`中文分类测试 ${marker}`);
      expect(res.status()).toBe(200);
      expect(res.headers()["x-helm-decided-by"]).toBe("eval");
    }
    expect((await (await request.get(`${mock}/__eval_count`)).json()).count).toBe(4);
    const terminal = await route("中文分类测试 __EVAL_ALL_BAD__");
    expect(terminal.status()).toBe(200);
    expect(terminal.headers()["x-helm-decided-by"]).toBe("fallback");
    expect(terminal.headers()["x-helm-lane"]).toBe("balanced");
    const explicit = await request.post("/v1/chat/completions", {
      headers: { Authorization: "Bearer helm_live_e2e_custom" },
      data: {
        model: "economy",
        messages: [{ role: "user", content: "中文分类测试" }],
        stream: false,
      },
    });
    expect(explicit.status()).toBe(200);
    expect((await (await request.get(`${mock}/__eval_count`)).json()).count).toBe(5);
    expect((await (await request.get(`${mock}/__jev_count`)).json()).count).toBe(6);
    config.eval.chain = [...candidates].reverse();
    expect(
      (await request.put("/admin/api/classifier", { headers: admin, data: config })).ok(),
    ).toBe(true);
    await route("中文分类测试 __JEV_OK__");
    expect((await (await request.get(`${mock}/__eval_count`)).json()).count).toBe(6);
    expect((await (await request.get(`${mock}/__jev_count`)).json()).count).toBe(6);
  });
  test("invalid classifier config is rejected without overwriting the saved chain", async ({
    request,
  }) => {
    const before = await (await request.get("/admin/api/classifier", { headers: admin })).json();
    const invalid = { ...before, eval: { ...before.eval, chain: [candidates[0], candidates[0]] } };
    expect(
      (await request.put("/admin/api/classifier", { headers: admin, data: invalid })).status(),
    ).toBe(400);
    expect(await (await request.get("/admin/api/classifier", { headers: admin })).json()).toEqual(
      before,
    );
  });
  test("UI saves priority, survives reload and fits desktop/mobile", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setExtraHTTPHeaders(admin);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/admin/classifier");
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Classifier", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add Jev", exact: true }).click();
    await expect(page.getByLabel("Classifier model 1", { exact: true })).toHaveValue(
      "typesafe/jev-1.13",
    );
    await expect(page.getByLabel("Classifier model 2", { exact: true })).toHaveValue("economy");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.reload();
    await expect(page.getByLabel("Classifier model 1", { exact: true })).toHaveValue(
      "typesafe/jev-1.13",
    );
    const saved = await (await request.get("/admin/api/classifier", { headers: admin })).json();
    expect(saved.eval.chain.map((c: { type: string }) => c.type)).toEqual(["jev", "chat"]);
    await page.evaluate(() => localStorage.setItem("helm_admin_locale", "zh-hans"));
    await page.reload();
    await expect(page.getByText("分类器调用顺序", { exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/helm-jev-desktop.png", fullPage: true });
    await page.evaluate(() => localStorage.setItem("helm_admin_locale", "en"));
    await page.reload();
    await page.getByRole("button", { name: "Move classifier 1 down", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.reload();
    await expect(page.getByLabel("Classifier model 1", { exact: true })).toHaveValue("economy");
    await page.evaluate(() => localStorage.setItem("helm_admin_locale", "zh-hans"));
    await page.reload();
    await expect(page.getByText("分类器调用顺序", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: "/tmp/helm-jev-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  });
});
