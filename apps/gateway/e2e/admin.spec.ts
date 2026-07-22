import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  basicHeader,
  SEED_KEY_PLAINTEXT,
  SEED_TRACE_ID,
} from "./fixtures/admin.js";

// e2e.admin — drive the REAL admin UI end-to-end: the Hono gateway serves the
// adapter-static SvelteKit SPA at /admin behind Admin auth; the browser passes
// pre-emptive Basic auth, edits a lane (persisted to the runtime config), and inspects a seeded
// request's decision trail. No front-end stubbing, no direct core access — every
// assertion goes through the built SPA + real gateway (docs/07, docs/11, docs/04).
//
// The `admin` Playwright project supplies a pre-emptive Authorization header so
// page.goto() is authenticated without a browser challenge; the `@noauth` cases
// run in a credential-less project and verify the first-party login redirect.

const BASE = "http://127.0.0.1:8090";
const SEED_MODEL_FILTER = "best_reasoning_model";

async function filterToSeededRequest(page: Page) {
  await page.getByTestId("filter-model").fill(SEED_MODEL_FILTER);
  await page.getByTestId("filter-model").press("Enter");
  // The model filter applies via a client navigation (?model=…) + loader refetch.
  // Wait for it to commit so callers assert against the *filtered* list, never one
  // still settling from a previous filter/reset — that overlap was the flake: a
  // reset's goto('?') and this goto('?model=…') raced, and whichever loader landed
  // last won (the `$effect` then re-synced the input from its data), so the filter
  // silently didn't stick and the seeded row never appeared.
  await expect(page).toHaveURL(/[?&]model=best_reasoning_model\b/);
  // The id cell's href is `/requests/<trace>?from=<list-url>` (the Back-link carries
  // the originating list), so match by substring, not exact suffix.
  return page
    .getByTestId("request-row")
    .filter({ has: page.locator(`a[href*="/requests/${SEED_TRACE_ID}"]`) });
}

// ── 1. Admin auth gate: none / wrong / correct (@noauth project) ─────────────
test.describe("admin auth gate @noauth", () => {
  test("redirects anonymous browser navigation to the login page", async () => {
    const ctx = await playwrightRequest.newContext();
    const res = await ctx.get(`${BASE}/admin`, {
      headers: { Accept: "text/html" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers().location).toBe("/admin/login?next=%2Fadmin");
    expect(res.headers()["www-authenticate"]).toBeUndefined();
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
    await page.getByRole("button", { name: /^save$/i }).click();

    // The one page-level success indicator appears after the atomic write-back.
    await expect(page.getByTestId("lanes-saved")).toBeVisible();

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
    // Other e2e specs run first and add many request rows, so filter to the seeded
    // request's unique served model instead of assuming it remains on page 1.
    const row = await filterToSeededRequest(page);
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

    const seededRow = await filterToSeededRequest(page);
    await expect(seededRow).toBeVisible();

    // Filter controls + numbered pager are present. The date range is the shared
    // RangeFilter calendar-day preset row (testid range-<key>), not a select;
    // 'today' is the default-active preset.
    await expect(page.getByTestId("filter-status")).toBeVisible();
    await expect(page.getByTestId("range-today")).toBeVisible();
    // Only the one seeded row exists → single page, Next disabled.
    await expect(page.getByTestId("pager-status")).toContainText("1 requests");
    await expect(page.getByTestId("pager-next")).toBeDisabled();

    // Status=error excludes the seeded ok row → empty state (filtered at the SQL
    // layer; the URL carries the filter).
    await page.getByTestId("filter-status").selectOption("error");
    await expect(page).toHaveURL(/status=error/);
    await expect(page.getByTestId("requests-empty")).toBeVisible();
    await expect(seededRow).toHaveCount(0);

    // Reset clears every filter; re-apply the seed filter so the assertion stays
    // independent of request rows created by earlier e2e specs. Wait for the reset
    // navigation to land (status param gone) BEFORE re-filtering, so the two gotos
    // never overlap.
    await page.getByTestId("filter-reset").click();
    await expect(page).not.toHaveURL(/status=error/);
    await filterToSeededRequest(page);
    await expect(seededRow).toBeVisible();

    // decided_by=eval excludes the rules-decided seeded row (JSON-path filter).
    await page.getByTestId("filter-decided-by").selectOption("eval");
    await expect(page.getByTestId("requests-empty")).toBeVisible();
    await page.getByTestId("filter-reset").click();
    await expect(page).not.toHaveURL(/decided_by=eval/); // reset navigation committed
    await filterToSeededRequest(page);
    await expect(seededRow).toBeVisible();

    // Model search matches the served/requested model substring; a miss empties it.
    await page.getByTestId("filter-model").fill(SEED_MODEL_FILTER);
    await page.getByTestId("filter-model").press("Enter");
    await expect(seededRow).toBeVisible(); // served model = best_reasoning_model
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
  test("renders the settings page and persists a capture mode across reloads", async ({ page }) => {
    await page.goto(`${BASE}/admin/settings`);
    await expect(page.getByTestId("capture-mode")).toBeVisible();
    await expect(page.getByTestId("log-level")).toBeVisible();

    // Full payload capture is the default; switch to metadata only and save.
    const captureMode = page.getByTestId("capture-mode");
    await expect(captureMode).toHaveValue("payload");
    await captureMode.selectOption("none");
    await page.getByRole("button", { name: /save settings/i }).click();
    await expect(page.getByRole("status")).toBeVisible(); // "Saved" badge

    // Re-load: the persisted (config_kv) value is reflected.
    await page.goto(`${BASE}/admin/settings`);
    await expect(page.getByTestId("capture-mode")).toHaveValue("none");

    // Restore the default so the throwaway DB doesn't affect other specs.
    await page.getByTestId("capture-mode").selectOption("payload");
    await page.getByRole("button", { name: /save settings/i }).click();
    await expect(page.getByRole("status")).toBeVisible();
  });
});

// ── 6. Payload view: the seeded request was stored WITHOUT a captured body ────
test.describe("admin request payload view", () => {
  test("shows a no-session notice when no payload or Session ID was captured", async ({ page }) => {
    // The seed uses telemetry.insert only (no insertPayload), so the detail page
    // must surface the explicit no-Session notice rather than a body.
    await page.goto(`${BASE}/admin/requests/${SEED_TRACE_ID}`);
    await expect(page.getByTestId("payload-summary")).toContainText(/no captured Session ID/i);
  });
});
