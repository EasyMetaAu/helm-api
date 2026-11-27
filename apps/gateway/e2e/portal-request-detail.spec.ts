import { expect, test } from "@playwright/test";

test("Portal shows the full owned request trail and loads upstream bodies with bearer auth", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("helm_portal_key", "helm_live_portal_fixture"),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const detail = {
    request_id: "portal-detail",
    trace_id: "client-trace",
    requested_model: "minimax-video",
    created_at: Date.now(),
    key_prefix: "helm_live_test",
    key_name: "My key",
    classifier: {
      task_type: "video",
      complexity: "low",
      confidence: 1,
      decided_by: "default",
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "video_generation" },
    lane: { selected_lane: "video", candidate_chain: ["minimax/MiniMax-H3"] },
    provider_attempts: [
      {
        alias: "minimax/MiniMax-H3",
        provider_name: "minimax",
        provider_model: "MiniMax-H3",
        skipped: false,
        status: "error",
        error_class: "upstream_rejected",
        latency_ms: 396,
        cost_usd: null,
        error_detail: {
          upstream_status: 401,
          message: "Native media request failed",
          provider_raw: { error: { code: "invalid_api_key" }, request_id: "upstream-123" },
        },
      },
    ],
    serving_account: {
      kind: "api_key",
      provider_id: "minimax",
      account: "account-id",
      label: "MiniMax team",
    },
    final: { status: "error", model_alias: null, error_reason: "upstream_rejected" },
    latency_total_ms: 396,
    generation_ms: null,
    fallback_count: 0,
    request_body_bytes: 100,
    cost_breakdown: { eval_usd: null, completion_usd: null, total_usd: null },
  };
  Object.assign(detail.final, { error_detail: detail.provider_attempts[0]!.error_detail });
  const parts: string[] = [];
  await page.route("**/portal/api/requests/portal-detail**", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer helm_live_portal_fixture");
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/payload")) return route.fulfill({ json: { decision: detail } });
    const part = url.searchParams.get("part");
    if (part === "meta")
      return route.fulfill({
        json: {
          captured: true,
          exact: true,
          source: "payload",
          parts: { request: true, response: false, upstream_request: true },
        },
      });
    parts.push(part ?? "");
    return route.fulfill({
      contentType: "application/vnd.helm.payload",
      body: JSON.stringify({
        model: part === "upstream_request" ? "MiniMax-H3" : "minimax-video",
        prompt: "A test scene",
      }),
    });
  });
  await page.goto("/portal/requests/portal-detail");
  await expect(page.getByTestId("request-summary")).toContainText("My key");
  for (const id of [
    "chain-classifier",
    "chain-eval",
    "chain-policy",
    "chain-lanes",
    "chain-attempts",
    "cost-breakdown",
    "token-usage",
    "throughput",
  ])
    await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("chain-attempts")).toContainText("MiniMax team");
  await page.getByTestId("attempt-error-detail").locator("summary").click();
  await expect(page.getByTestId("attempt-error-detail")).toContainText("invalid_api_key");
  await expect(page.getByTestId("request-error")).toContainText("401");
  expect(parts).toEqual([]);
  await page.getByTestId("load-upstream-request").click();
  await expect(page.getByTestId("upstream-request-body")).toContainText("MiniMax-H3");
  expect(parts.sort()).toEqual(["request", "upstream_request"]);
  await expect(page.getByTestId("retry-request")).toHaveCount(0);
  await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`portal-detail-${width}.png`),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});
