import { expect, test } from "@playwright/test";

test("connection check proves inference separately from authentication", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("helm_portal_key", "helm_live_browser_fixture"),
  );
  await page.route("**/mcp", (route) => route.fulfill({ status: 404, body: "disabled" }));
  await page.route("**/v1/models", (route) => route.fulfill({ json: { data: [{ id: "auto" }] } }));
  let attempts = 0;
  await page.route("**/v1/messages", async (route) => {
    attempts++;
    expect(route.request().postDataJSON()).toMatchObject({ model: "work", stream: true });
    const body = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join("");
    await route.fulfill({
      contentType: "text/event-stream",
      headers: { "X-Helm-Request-Id": "inference-fixture", "X-Trace-Id": "not-the-request" },
      body,
    });
  });
  await page.goto("/portal/connect");
  await expect(page.getByRole("heading", { name: "1. Choose a client" })).toBeVisible();
  await expect(page.getByText("Configuration ready to copy", { exact: true })).toBeVisible();
  await page.getByLabel("Lane", { exact: true }).fill("work");
  await expect(page.getByText("Provider charges may apply.", { exact: false })).toBeVisible();
  expect(attempts).toBe(0);
  await page.getByRole("button", { name: "Test inference", exact: true }).click();
  await expect(page.getByText("Inference completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Authentication passed", { exact: true })).toBeVisible();
  expect(attempts).toBe(1);
  await expect(page.getByRole("link", { name: "View test request" })).toHaveAttribute(
    "href",
    "/portal/requests/inference-fixture",
  );
  await expect(page.getByText("Local client not verified", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Browser checks do not verify your local client configuration.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("connection-success.png"), fullPage: true });

  await page.getByRole("tab", { name: "Codex", exact: true }).click();
  await expect(page.getByText("codex --profile helm", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "View test request" })).toHaveCount(0);
  await expect(page.getByText("Authentication passed", { exact: true })).toHaveCount(0);
  await page.route("**/v1/responses", (route) =>
    route.fulfill({ status: 503, json: { error: { message: "offline" } } }),
  );
  await page.getByRole("button", { name: "Test inference", exact: true }).click();
  await expect(page.getByText("Inference not confirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("Authentication passed", { exact: true })).toBeVisible();
  await expect(page.getByText("HTTP 503", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Check the lane and available capacity, then retry. An administrator can inspect the request details.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Test inference", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("connection-failure.png"), fullPage: true });
});

test("copying configuration is separate from authentication, cancellation and client verification", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => sessionStorage.setItem("helm_portal_key", "helm_fixture_key"));
  await page.route("**/mcp", (route) => route.fulfill({ status: 404 }));
  await page.goto("/portal/connect");
  await page.getByRole("button", { name: "Copy", exact: true }).last().click();
  await expect(page.getByText("Configuration copied", { exact: true })).toBeVisible();
  await expect(page.getByText("Authentication passed", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Local client not verified", { exact: true })).toBeVisible();
  await page.getByLabel("Lane", { exact: true }).fill("work");
  await expect(page.getByText("Configuration ready to copy", { exact: true })).toBeVisible();
  await expect(page.locator("pre")).toContainText("ANTHROPIC_MODEL='work'");
  await page.route("**/v1/models", (route) => route.fulfill({ status: 401, json: {} }));
  await page.getByRole("button", { name: "Test inference", exact: true }).click();
  await expect(page.getByText("Authentication failed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Check your key and its permissions, then sign in again if needed."),
  ).toBeVisible();
  await page.route("**/v1/models", (route) => route.fulfill({ json: { data: [] } }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/messages", async (route) => {
    await held;
    await route.abort().catch(() => {});
  });
  await page.getByRole("button", { name: "Test inference", exact: true }).click();
  await expect(
    page.getByText("Authentication passed. Waiting for a complete response…"),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Codex", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Test cancelled. Run it again when ready.")).toBeVisible();
  await expect(page.getByText("Authentication passed", { exact: true })).toBeVisible();
  release();
});

test("a completed test opens its own portal request record", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem("helm_portal_key", "helm_fixture_key"));
  await page.route("**/mcp", (route) => route.fulfill({ status: 404 }));
  await page.route("**/v1/models", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/v1/chat/completions", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      headers: { "X-Helm-Request-Id": "own-request" },
      body: 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    }),
  );
  await page.route("**/portal/api/requests/own-request", (route) =>
    route.fulfill({
      json: {
        request_id: "own-request",
        trace_id: "own-request",
        requested_model: "auto",
        served_model: "fixture-model",
        lane: "balanced",
        status: "ok",
        error_reason: null,
        latency_ms: 10,
        cost_usd: null,
        usage: null,
        requested_reasoning_effort: null,
        reasoning_effort: null,
        attempts: [],
      },
    }),
  );
  await page.route("**/portal/api/requests/own-request/payload?part=meta", (route) =>
    route.fulfill({ json: { captured: false } }),
  );
  await page.goto("/portal/connect");
  await expect(page).toHaveTitle("Helm Portal");
  await page.getByRole("tab", { name: "OpenAI SDK", exact: true }).click();
  await page.getByRole("button", { name: "Test inference", exact: true }).click();
  await expect(page.getByText("Inference completed", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View test request" }).click();
  await expect(page).toHaveURL(/\/portal\/requests\/own-request$/);
  await expect(page.getByRole("heading", { name: "Request", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("fixture-model", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
