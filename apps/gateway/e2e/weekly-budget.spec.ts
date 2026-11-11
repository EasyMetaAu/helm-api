import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, basicHeader } from "./fixtures/admin.js";

const adminHeaders = { Authorization: basicHeader(ADMIN_USER, ADMIN_PASSWORD) };
const anchor = "2026-11-08T16:00:00Z";
const chat = {
  model: "auto",
  messages: [{ role: "user", content: "hi thanks, ok" }],
  stream: false,
  response_format: { type: "json_object" },
};

test("weekly quota can be created, edited and read back through the real admin UI", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setExtraHTTPHeaders(adminHeaders);
  await page.goto("/admin/keys");
  await expect(page).toHaveTitle(/Helm/);
  await page.getByRole("button", { name: "New key", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  const name = `weekly-ui-${Date.now()}`;
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.locator("summary").filter({ hasText: "Usage budgets" }).click();
  await dialog.getByLabel("Budget period", { exact: true }).selectOption("weekly");
  await dialog.getByLabel("Cycle start (local time)").fill("2026-11-09T00:00");
  await dialog.getByLabel("Max requests", { exact: true }).fill("2");
  await dialog.getByLabel("Max tokens", { exact: true }).fill("10000");
  await dialog.getByLabel("Max spend (USD)", { exact: true }).fill("5");
  await expect(dialog.getByLabel("Window (seconds)")).toHaveCount(0);
  await dialog.getByLabel("Budget period").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/helm-weekly-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/helm-weekly-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Create key", exact: true }).click();
  const plaintext = (await dialog.getByTestId("plaintext-reveal").textContent())?.trim();
  expect(plaintext).toBeTruthy();
  await dialog.getByRole("button", { name: "I saved it" }).click();
  const list = await (await request.get("/admin/api/keys", { headers: adminHeaders })).json();
  const key = list.find((row: { name: string }) => row.name === name);
  expect(key.budget_weekly_anchor).toBeTruthy();
  expect(key.over_budget_behavior).toBe("reject");
  const headers = { Authorization: `Bearer ${plaintext}` };
  const first = await request.post("/v1/chat/completions", { headers, data: chat });
  expect(first.status(), await first.text()).toBe(200);
  const detail = await (
    await request.get(`/admin/api/keys/${key.key_id}`, { headers: adminHeaders })
  ).json();
  expect(detail.weekly_budget.requests).toMatchObject({ limit: 2, used: 1, remaining: 1 });
  await page.goto(`/admin/keys/${key.key_id}`);
  await expect(page.getByText("Next reset", { exact: false })).toBeVisible();
  await expect(page.getByText("1 used, 1 remaining of 2", { exact: false })).toBeVisible();
  const portal = await (await request.get("/portal/api/me", { headers })).json();
  expect(portal.budget.current_cycle.requests.used).toBe(1);
  await page.goto("/admin/keys");
  const row = page.getByTestId("key-row").filter({ hasText: name });
  await row.getByRole("button", { name: /^edit$/i }).click();
  const edit = page.getByRole("dialog", { name: "Edit key" });
  await expect(edit.getByLabel("Budget period")).toHaveValue("weekly");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).not.toBeVisible();
  const unchanged = await (
    await request.get(`/admin/api/keys/${key.key_id}`, { headers: adminHeaders })
  ).json();
  expect(unchanged.budget_weekly_anchor).toBe(key.budget_weekly_anchor);
  expect(unchanged.weekly_budget.requests.used).toBe(1);
  await page.evaluate(() => localStorage.setItem("helm_admin_locale", "zh-hans"));
  await page.reload();
  await page
    .getByTestId("key-row")
    .filter({ hasText: name })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const chineseDialog = page.getByRole("dialog");
  await expect(chineseDialog.getByLabel("配额周期")).toHaveValue("weekly");
  await page.setViewportSize({ width: 1280, height: 900 });
  await chineseDialog
    .getByLabel("配额周期")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "/tmp/helm-weekly-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await chineseDialog
    .getByLabel("配额周期")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "/tmp/helm-weekly-mobile.png" });
  expect(errors).toEqual([]);
});

test("weekly request limit is shared by Chat, Anthropic, Responses and Gemini", async ({
  request,
}) => {
  for (const face of ["messages", "responses", "gemini"]) {
    const created = await request.post("/admin/api/keys", {
      headers: adminHeaders,
      data: {
        name: `weekly-${face}`,
        budget_requests: 1,
        budget_weekly_anchor: anchor,
      },
    });
    expect(created.status()).toBe(201);
    const { plaintext, key_id: keyId } = await created.json();
    const headers = { Authorization: `Bearer ${plaintext}` };
    const result =
      face === "messages"
        ? await request.post("/v1/messages", {
            headers: { "x-api-key": plaintext, "anthropic-version": "2023-06-01" },
            data: {
              model: "balanced",
              max_tokens: 8,
              messages: [{ role: "user", content: "hi" }],
              stream: false,
            },
          })
        : face === "responses"
          ? await request.post("/v1/responses", {
              headers,
              data: { model: "balanced", input: "hi", stream: false },
            })
          : await request.post("/v1beta/models/balanced:generateContent", {
              headers: { "x-goog-api-key": plaintext },
              data: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
            });
    expect(result.status(), await result.text()).toBe(200);
    const blocked = await request.post("/v1/chat/completions", { headers, data: chat });
    expect(blocked.status()).toBe(429);
    const detail = await (
      await request.get(`/admin/api/keys/${keyId}`, { headers: adminHeaders })
    ).json();
    expect(detail.weekly_budget.requests.used).toBe(1);
  }
});

test("weekly token and spend caps block subsequent requests independently", async ({ request }) => {
  for (const cap of [{ budget_tokens: 1 }, { budget_spend_usd: 0.000000001 }]) {
    const created = await request.post("/admin/api/keys", {
      headers: adminHeaders,
      data: { ...cap, budget_weekly_anchor: anchor },
    });
    const { plaintext } = await created.json();
    const headers = { Authorization: `Bearer ${plaintext}` };
    const first = await request.post("/v1/images/generations", {
      headers,
      data: { model: "gpt-image-2", prompt: "red apple", response_format: "b64_json" },
    });
    expect(first.status(), await first.text()).toBe(200);
    const second = await request.post("/v1/chat/completions", { headers, data: chat });
    expect(second.status()).toBe(429);
  }
});
