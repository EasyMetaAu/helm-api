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
    windows: [
      { key: "5h", usedPercent: 74, resetsAtMs: Date.now() + 3600000, windowMinutes: 300 },
      {
        key: "primary",
        usedPercent: 100,
        resetsAtMs: Date.now() + 5 * 86400000,
        windowMinutes: 10080,
      },
    ],
    credits: { hasCredits: true, balance: "87008.6848637500", unlimited: false },
    rateLimitReachedType: "rate_limit_reached",
  };
  await page.route("**/admin/api/oauth/overview*", (route) =>
    route.fulfill({
      json: {
        configured: true,
        selectionStrategy: "balanced",
        providers: [
          {
            id: "anthropic",
            name: "Remote Claude",
            flow: "manual_paste",
            accounts: [
              {
                account: "local-team",
                healthy: true,
                expiresAt: null,
                updatedAt: Date.now(),
                priority: 50,
                schedulable: true,
                fastMode: false,
                models: ["claude-sonnet"],
                anthropicPlanType: "max",
              },
            ],
          },
        ],
        usage: [
          {
            providerId: "anthropic",
            account: "local-team",
            requests: 42,
            tokens: 1536,
            costUsd: null,
            rpm: 1,
          },
        ],
        quota: [{ ...quota, account: "local-team", credits: null, rateLimitReachedType: null }],
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
          apiKeyPools: [
            {
              id: "openai",
              type: "openai",
              accounts: [
                {
                  id: "pool-ready",
                  name: "Team API key",
                  enabled: true,
                  state: "ready",
                  nextRetryAt: null,
                },
              ],
              usage: [{ account: "pool-ready", requests: 500, tokens: 1600000, costUsd: 2.51 }],
            },
          ],
        },
      },
    });
  });
  await page.goto("/admin/providers");
  const section = page.getByRole("region", { name: "Upstream usage" });
  await expect(section.getByText("74%", { exact: true })).toBeVisible();
  await expect(section.getByText("https://upstream.example", { exact: true })).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(1);
  await expect(section.getByRole("progressbar")).toHaveCount(2);
  await expect(section.locator(".progress-bar.bg-red-500")).toHaveCount(1);
  await expect(section.getByText("Ready", { exact: true })).toHaveClass("badge-ok");
  await section.locator("summary").click();
  await expect(section.getByText("87,008.68", { exact: true })).toHaveAttribute(
    "title",
    "87008.6848637500",
  );
  await section.locator("summary").click();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("link", { name: /remote-team/ })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect((await section.locator("header").boundingBox())?.height).toBeLessThan(130);
    if (width === 1440) {
      const upstreamBar = await section.locator(".progress-track").first().boundingBox();
      const localBar = await page
        .getByTestId("provider-quota-cell")
        .locator(".progress-track")
        .first()
        .boundingBox();
      expect(upstreamBar?.width).toBe(localBar?.width);
    }
    await page.screenshot({ path: `/tmp/helm-opus-${width}.png` });
    await section.locator("summary").click();
    const panel = section.locator(".menu-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/helm-opus-details-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
  }
  offline = true;
  await section.getByRole("button", { name: "Refresh upstream usage" }).click();
  await expect(section.getByRole("alert")).toBeVisible();
  await expect(section.getByText("74%", { exact: true })).toBeVisible();
  offline = false;
  await section.getByRole("link", { name: /remote-team/ }).click();
  await expect(page).toHaveURL(/source=upstream/);
  await expect(page.getByRole("heading", { name: /remote-team/ })).toBeVisible();
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
