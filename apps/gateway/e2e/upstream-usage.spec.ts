import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, basicHeader } from "./fixtures/admin.js";

const usageToken = "e2e-read-only-usage-token";
test.use({ httpCredentials: { username: ADMIN_USER, password: ADMIN_PASSWORD } });

test("upstream usage renders quota and history without account mutations", async ({ page }) => {
  await page.setExtraHTTPHeaders({ Authorization: basicHeader(ADMIN_USER, ADMIN_PASSWORD) });
  const quota = {
    providerId: "anthropic",
    account: "remote-team",
    source: "anthropic",
    capturedAt: Date.now(),
    usageLimitedUntilMs: null,
    windows: [{ key: "5h", usedPercent: 74, resetsAtMs: Date.now() + 3600000, windowMinutes: 300 }],
  };
  let offline = false;
  await page.route("**/admin/api/upstream/provider-usage**", async (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers().authorization ?? "").not.toContain(usageToken);
    if (offline) return route.fulfill({ status: 502, json: { error: "unavailable" } });
    if (route.request().url().includes("/periods?"))
      return route.fulfill({
        json: {
          current: [
            {
              windowKey: "5h",
              periodStartMs: Date.now() - 3600000,
              periodEndMs: Date.now() + 3600000,
              requests: 42,
              tokens: 1536,
              costUsd: null,
              approximate: false,
              partial: false,
            },
          ],
          periods: [],
          daily: [],
          weekly: [],
        },
      });
    return route.fulfill({
      json: {
        configured: true,
        source: "https://upstream.example",
        snapshot: {
          schemaVersion: 1,
          generatedAt: Date.now(),
          providers: [
            {
              id: "anthropic",
              name: "Remote Claude",
              accounts: [
                {
                  account: "remote-team",
                  healthy: true,
                  schedulable: true,
                  anthropicPlanType: "max",
                },
              ],
            },
          ],
          usage: [
            {
              providerId: "anthropic",
              account: "remote-team",
              requests: 42,
              tokens: 1536,
              costUsd: null,
              rpm: 1,
            },
          ],
          quota: [quota],
          apiKeyPools: [],
        },
      },
    });
  });
  await page.goto("/admin/providers");
  const section = page.getByRole("region", { name: "Upstream usage" });
  await expect(section.getByText("74%", { exact: true })).toBeVisible();
  await expect(section.getByText("https://upstream.example", { exact: true })).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(1);
  offline = true;
  await section.getByRole("button", { name: "Refresh upstream usage" }).click();
  await expect(section.getByRole("alert")).toBeVisible();
  await expect(section.getByText("74%", { exact: true })).toBeVisible();
  offline = false;
  await section.getByRole("link", { name: "remote-team" }).click();
  await expect(page).toHaveURL(/source=upstream/);
  await expect(page.getByRole("heading", { name: "remote-team" })).toBeVisible();
  await expect(page.getByText(/https:\/\/upstream.example/)).toBeVisible();
});

test("real gateway export auth is separate from inference and admin auth", async ({
  request,
  playwright,
}) => {
  const unauthorized = await request.get("/v1/provider-usage", {
    headers: { authorization: "Bearer helm_live_e2e_testkey" },
  });
  expect(unauthorized.status()).toBe(401);
  const authorized = await request.get("/v1/provider-usage", {
    headers: { authorization: `Bearer ${usageToken}` },
  });
  expect(authorized.status()).toBe(200);
  expect(await authorized.json()).toMatchObject({
    schemaVersion: 1,
    providers: expect.any(Array),
    quota: expect.any(Array),
  });
  expect(
    (
      await request.post("/v1/provider-usage/refresh", {
        headers: { authorization: `Bearer ${usageToken}` },
      })
    ).status(),
  ).toBe(404);
  const anonymous = await playwright.request.newContext();
  try {
    const unauthenticated = await anonymous.get(
      new URL("/admin/api/upstream/provider-usage", authorized.url()).href,
      { headers: { authorization: `Bearer ${usageToken}` } },
    );
    expect(unauthenticated.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});
