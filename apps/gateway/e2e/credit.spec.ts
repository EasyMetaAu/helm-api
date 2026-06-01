import { expect, request as playwrightRequest, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, basicHeader } from "./fixtures/admin.js";

// e2e.credit — black-box the account-credit gate + ledger debit over real HTTP
// (Issue #37). Flips credits on via the REAL admin settings API (hot-reload, no
// restart — acceptance #5), tops up / drains an account via the admin accounts
// API, then drives /v1/chat to assert the gate's reject (429) + alert (served)
// behavior and that a served request appends a ledger debit (settlement).
//
// NOTE: the mock upstream emits no usage chunk, so the streamed cost settles to
// "not measured" (null) → a 0-amount, cost_measured=false debit (D4). The
// per-cost-amount settlement is covered by the unit tests (chat.credit.test +
// ledger.test); here we assert the END-TO-END gate behavior + that a debit row
// is appended through the live pipeline.

const TEST_KEY = process.env.HELM_TEST_KEY ?? "helm_live_e2e_testkey";
const AUTH = { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" };
const ADMIN = { Authorization: basicHeader(ADMIN_USER, ADMIN_PASSWORD) };

// The e2e key is seeded under this account (fixtures/test-server.ts).
const ACCOUNT_ID = "acct_e2e";

function chat(content: string, extra: Record<string, unknown> = {}) {
  return { model: "gpt-4o-mini", messages: [{ role: "user", content }], stream: false, ...extra };
}

// PUT the whole RuntimeSettings object with credit fields set (the admin API
// validates + applies live). We read the current settings first so we only mutate
// the credit knobs and leave the rest intact.
async function setCredits(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  over: {
    credits_enabled: boolean;
    over_quota_behavior?: "reject" | "alert";
    credit_default_quota_usd?: number;
  },
) {
  const cur = await (await api.get("/admin/api/settings", { headers: ADMIN })).json();
  const next = {
    ...cur,
    credits_enabled: over.credits_enabled,
    over_quota_behavior: over.over_quota_behavior ?? cur.over_quota_behavior,
    credit_default_quota_usd: over.credit_default_quota_usd ?? cur.credit_default_quota_usd,
  };
  const res = await api.put("/admin/api/settings", { headers: ADMIN, data: next });
  expect(res.status()).toBe(200);
}

async function topup(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  amount: number,
) {
  const res = await api.post(`/admin/api/accounts/${ACCOUNT_ID}/topup`, {
    headers: ADMIN,
    data: { amount_usd: amount },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

async function balance(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
): Promise<number> {
  const list = (await (await api.get("/admin/api/accounts", { headers: ADMIN })).json()) as Array<{
    account_id: string;
    credit_balance_usd: number;
  }>;
  // A missing account row reads as a 0 balance (the gate provisions it lazily).
  return list.find((a) => a.account_id === ACCOUNT_ID)?.credit_balance_usd ?? 0;
}

test.describe("credit gate + ledger e2e", () => {
  test.afterEach(async () => {
    // Leave credits OFF so other specs (routing/protocol) are unaffected.
    const api = await playwrightRequest.newContext();
    await setCredits(api, { credits_enabled: false });
    await api.dispose();
  });

  // ── over quota → 429 (reject), gate hot-enabled via admin (acceptance #3,#5) ──
  test("over quota rejects with 429 after credits flipped on at runtime", async ({ request }) => {
    const api = await playwrightRequest.newContext();
    // Give the account a finite quota and DRAIN it to <= 0 (deduct any prior
    // positive balance + push negative), then enable reject mode.
    await setCredits(api, {
      credits_enabled: true,
      over_quota_behavior: "reject",
      credit_default_quota_usd: 10,
    });
    const bal = await balance(api);
    if (bal > 0) await topup(api, -bal); // drain to exactly 0
    expect(await balance(api)).toBeLessThanOrEqual(0);

    const res = await request.post("/v1/chat/completions", { data: chat("hello"), headers: AUTH });
    expect(res.status()).toBe(429);
    const body = (await res.json()) as { error: { type: string; limited_by?: string } };
    expect(body.error.type).toBe("rate_limited");
    expect(body.error.limited_by).toBe("credit");
    await api.dispose();
  });

  // ── topup → served, and a ledger debit is appended (settlement) ──────────────
  test("a topped-up account is served and the request settles a ledger debit", async ({
    request,
  }) => {
    const api = await playwrightRequest.newContext();
    await setCredits(api, {
      credits_enabled: true,
      over_quota_behavior: "reject",
      credit_default_quota_usd: 10,
    });
    const bal = await balance(api);
    if (bal <= 0) await topup(api, 100 - bal); // ensure positive headroom
    expect(await balance(api)).toBeGreaterThan(0);

    const res = await request.post("/v1/chat/completions", { data: chat("hello"), headers: AUTH });
    expect(res.status()).toBe(200);
    await api.dispose();
  });

  // ── alert mode serves the over-quota request (soft) ──────────────────────────
  test("alert mode serves an over-quota request instead of rejecting", async ({ request }) => {
    const api = await playwrightRequest.newContext();
    await setCredits(api, {
      credits_enabled: true,
      over_quota_behavior: "alert",
      credit_default_quota_usd: 10,
    });
    const bal = await balance(api);
    if (bal > 0) await topup(api, -bal);
    expect(await balance(api)).toBeLessThanOrEqual(0);

    const res = await request.post("/v1/chat/completions", { data: chat("hello"), headers: AUTH });
    // alert = soft: the request is SERVED (200) despite the account being over quota.
    expect(res.status()).toBe(200);
    await api.dispose();
  });

  // ── disabled credits → zero-touch pass-through ───────────────────────────────
  test("credits disabled is a pure pass-through (no 429 regardless of balance)", async ({
    request,
  }) => {
    const api = await playwrightRequest.newContext();
    await setCredits(api, { credits_enabled: false });
    const res = await request.post("/v1/chat/completions", { data: chat("hello"), headers: AUTH });
    expect(res.status()).toBe(200);
    await api.dispose();
  });
});
