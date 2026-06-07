import { expect, request as playwrightRequest, test } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  basicHeader,
  SEED_KEY_PLAINTEXT,
  SEED_TRACE_ID,
} from "./fixtures/admin.js";

// e2e.admin — drive the REAL admin UI end-to-end: the Hono gateway serves the
// adapter-static SvelteKit SPA at /admin behind HTTP Basic; the browser passes
// auth, edits a lane (persisted to the runtime config), and inspects a seeded
// request's decision trail. No front-end stubbing, no direct core access — every
// assertion goes through the built SPA + real gateway (docs/07, docs/11, docs/04).
//
// The `admin` Playwright project supplies httpCredentials so page.goto() is
// pre-authenticated; the `@noauth` cases run in a credential-less project so the
// HTTP Basic challenge is observable (a credentialed context would auto-answer it).

const BASE = "http://127.0.0.1:8090";

// ── 1. Basic Auth gate: none / wrong / correct (@noauth project) ─────────────
test.describe("admin basic auth gate @noauth", () => {
  test("rejects with 401 when no credentials are supplied", async () => {
    const ctx = await playwrightRequest.newContext();
    const res = await ctx.get(`${BASE}/admin`);
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toContain("Basic");
    await ctx.dispose();
  });

  test("rejects with 401 on a wrong password", async () => {
    const ctx = await playwrightRequest.newContext();
    const res = await ctx.get(`${BASE}/admin`, {
      headers: { Authorization: basicHeader(ADMIN_USER, "definitely-wrong") },
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test("serves the SPA with 200 on correct credentials", async () => {
    const ctx = await playwrightRequest.newContext();
    const res = await ctx.get(`${BASE}/admin`, {
      headers: { Authorization: basicHeader(ADMIN_USER, ADMIN_PASSWORD) },
    });
    expect(res.status()).toBe(200);
    // The adapter-static SPA shell is the index.html the gateway serves.
    expect((await res.text()).toLowerCase()).toContain("<!doctype html");
    await ctx.dispose();
  });
});

// ── 2. Edit a lane and verify it persists across a reload ────────────────────
test.describe("admin lane editing", () => {
  test("editing a lane primary persists after reload", async ({ page }) => {
    const newPrimary = `e2e_edited_${Date.now()}`;

    await page.goto(`${BASE}/admin/lanes`);
    // Scope the card by its heading so a lane that merely lists "economy" as a
    // fallback does not also match (the balanced card references economy).
    const card = page
      .getByTestId("lane-card")
      .filter({ has: page.getByRole("heading", { name: "economy", exact: true }) });
    await expect(card).toBeVisible();

    const primary = card.locator("input[name='primary']");
    await primary.fill(newPrimary);
    await card.getByRole("button", { name: /save/i }).click();

    // A per-card success indicator must appear after the write-back succeeds.
    await expect(card.getByTestId("lane-saved")).toBeVisible();

    // Reload from the gateway: the runtime config kept the edit (docs/04).
    await page.reload();
    const reloaded = page
      .getByTestId("lane-card")
      .filter({ has: page.getByRole("heading", { name: "economy", exact: true }) });
    await expect(reloaded.locator("input[name='primary']")).toHaveValue(newPrimary);
  });
});

// ── 3. View a seeded request's decision trail ────────────────────────────────
test.describe("admin request debugging", () => {
  test("the seeded request appears in the list and opens its decision chain", async ({ page }) => {
    await page.goto(`${BASE}/admin/requests`);

    // The seeded row is identified by its detail link (carries the trace id) —
    // the list cells show derived columns (decided_by/lane/cost), not the raw id.
    const row = page
      .getByTestId("request-row")
      .filter({ has: page.locator(`a[href$="/requests/${SEED_TRACE_ID}"]`) });
    await expect(row).toBeVisible();
    // Classification-stage decision layer is shown (decided_by column, Principle 5).
    await expect(row.getByTestId("decided-by")).toHaveText("rules");

    // Drill into the detail by deep-linking the trace id (SPA fallback route).
    await page.goto(`${BASE}/admin/requests/${SEED_TRACE_ID}`);

    // Decision chain blocks must be visible (docs/07): classifier output, lane
    // candidate chain, provider attempts, cost breakdown, trace_id.
    await expect(page.getByTestId("chain-classifier")).toBeVisible();
    await expect(page.getByTestId("chain-lanes")).toBeVisible();
    await expect(page.getByTestId("chain-attempts")).toBeVisible();
    const bodyText = (await page.locator("body").textContent()) ?? "";
    expect(bodyText).toContain(SEED_TRACE_ID); // trace_id surfaced
    expect(bodyText).toContain("coding"); // classifier task_type
    expect(bodyText).toContain("premium"); // lane candidate chain head
    expect(bodyText).toContain("best_reasoning_model"); // provider attempt alias
    // cost breakdown block is rendered
    await expect(page.getByText(/cost/i).first()).toBeVisible();
  });
});

// ── 3b. Filter + paginate the request list (real gateway SQL) ────────────────
test.describe("admin request list filtering + pagination", () => {
  test("filters narrow the list and the pager reflects the filtered total", async ({ page }) => {
    await page.goto(`${BASE}/admin/requests`);

    const seededRow = page
      .getByTestId("request-row")
      .filter({ has: page.locator(`a[href$="/requests/${SEED_TRACE_ID}"]`) });
    await expect(seededRow).toBeVisible();

    // Filter controls + numbered pager are present. The date range is the shared
    // RangeFilter preset-button row (testid range-<key>), not a select.
    await expect(page.getByTestId("filter-status")).toBeVisible();
    await expect(page.getByTestId("range-24h")).toBeVisible();
    // Only the one seeded row exists → single page, Next disabled.
    await expect(page.getByTestId("pager-status")).toContainText("1 requests");
    await expect(page.getByTestId("pager-next")).toBeDisabled();

    // Status=error excludes the seeded ok row → empty state (filtered at the SQL
    // layer; the URL carries the filter).
    await page.getByTestId("filter-status").selectOption("error");
    await expect(page).toHaveURL(/status=error/);
    await expect(page.getByTestId("requests-empty")).toBeVisible();
    await expect(seededRow).toHaveCount(0);

    // Reset clears every filter → the row returns.
    await page.getByTestId("filter-reset").click();
    await expect(seededRow).toBeVisible();

    // decided_by=eval excludes the rules-decided seeded row (JSON-path filter).
    await page.getByTestId("filter-decided-by").selectOption("eval");
    await expect(page.getByTestId("requests-empty")).toBeVisible();
    await page.getByTestId("filter-reset").click();
    await expect(seededRow).toBeVisible();

    // Model search matches the served/requested model substring; a miss empties it.
    await page.getByTestId("filter-model").fill("gpt-4o");
    await page.getByTestId("filter-model").press("Enter");
    await expect(seededRow).toBeVisible(); // requested_model = gpt-4o-mini
    await page.getByTestId("filter-model").fill("does-not-exist");
    await page.getByTestId("filter-model").press("Enter");
    await expect(page.getByTestId("requests-empty")).toBeVisible();
  });
});

// ── 4. Redaction smoke: no plaintext API key on the request views ────────────
test.describe("admin redaction smoke", () => {
  test("request list and detail never render a plaintext API key", async ({ page }) => {
    await page.goto(`${BASE}/admin/requests`);
    expect((await page.locator("body").textContent()) ?? "").not.toContain(SEED_KEY_PLAINTEXT);

    await page.goto(`${BASE}/admin/requests/${SEED_TRACE_ID}`);
    expect((await page.locator("body").textContent()) ?? "").not.toContain(SEED_KEY_PLAINTEXT);
  });
});

// ── 5. System Settings: read + persist a runtime-mutable setting ─────────────
test.describe("admin system settings", () => {
  test("renders the settings page and persists a toggle across reloads", async ({ page }) => {
    await page.goto(`${BASE}/admin/settings`);
    await expect(page.getByTestId("capture-payloads")).toBeVisible();
    await expect(page.getByTestId("log-level")).toBeVisible();

    // Capture is ON by default; toggle it OFF and save.
    const capture = page.getByTestId("capture-payloads");
    await expect(capture).toBeChecked();
    await capture.uncheck();
    await page.getByRole("button", { name: /save settings/i }).click();
    await expect(page.getByRole("status")).toBeVisible(); // "Saved" badge

    // Re-load: the persisted (config_kv) value is reflected → toggle stays OFF.
    await page.goto(`${BASE}/admin/settings`);
    await expect(page.getByTestId("capture-payloads")).not.toBeChecked();

    // Restore the default so the throwaway DB doesn't affect other specs.
    await page.getByTestId("capture-payloads").check();
    await page.getByRole("button", { name: /save settings/i }).click();
    await expect(page.getByRole("status")).toBeVisible();
  });
});

// ── 6. Payload view: the seeded request was stored WITHOUT a captured body ────
test.describe("admin request payload view", () => {
  test("shows a not-recorded notice when no payload was captured", async ({ page }) => {
    // The seed uses telemetry.insert only (no insertPayload), so the detail page
    // must surface the explicit "not recorded" notice rather than a body.
    await page.goto(`${BASE}/admin/requests/${SEED_TRACE_ID}`);
    await expect(page.getByTestId("payload-summary")).toContainText(/not recorded/i);
  });
});
