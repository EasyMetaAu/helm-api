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
    await route.fulfill({ contentType: "text/event-stream", body });
  });
  await page.goto("/portal/connect");
  await page.getByLabel("Lane to test").fill("work");
  await expect(page.getByText("Provider charges may apply.", { exact: false })).toBeVisible();
  expect(attempts).toBe(0);
  await page.getByRole("button", { name: "Test inference", exact: true }).click();
  await expect(page.getByText("Inference completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Authentication passed", { exact: true })).toBeVisible();
  expect(attempts).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("connection-success.png"), fullPage: true });

  await page.getByRole("tab", { name: "Codex", exact: true }).click();
  await expect(page.getByText("codex --profile helm", { exact: false })).toBeVisible();
  await page.route("**/v1/responses", (route) =>
    route.fulfill({ status: 503, json: { error: { message: "offline" } } }),
  );
  await page.getByRole("button", { name: "Test inference", exact: true }).click();
  await expect(page.getByText("Inference not confirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("Authentication passed", { exact: true })).toBeVisible();
  await expect(page.getByText("HTTP 503", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("connection-failure.png"), fullPage: true });
});
