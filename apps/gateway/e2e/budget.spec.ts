import { expect, test } from "@playwright/test";

// e2e.budget — per-key usage budgets end-to-end (docs/06) over real HTTP into a
// real gateway + the deterministic mock upstream. The two budget keys (seeded in
// fixtures/test-server.ts) cap REQUESTS at 1 over the window, so the FIRST request
// is served (cold bucket = full) and the SECOND is over budget. Request-count needs
// no upstream usage, so this is fully deterministic.
//
//  • degrade key → the over-budget request is DROPPED to the economy lane (cost is
//    bounded, service is NOT interrupted): a 200 with x-helm-lane=economy.
//  • reject  key → the over-budget request is a structured 429.
//
// The DEPLETING first request is NON-streaming so its post-served budget settle is
// awaited before the response returns (a streamed settle runs in a finally that the
// client may not wait for — that would race the second request).

const DEGRADE_AUTH = {
  Authorization: "Bearer helm_live_e2e_budget_degrade",
  "Content-Type": "application/json",
};
const REJECT_AUTH = {
  Authorization: "Bearer helm_live_e2e_budget_reject",
  "Content-Type": "application/json",
};

// A simple JSON-constrained request routes to the non-stream `json` lane (served by
// the mock), so the first request settles synchronously and deterministically.
const DEPLETE = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi thanks, ok" }],
  stream: false,
  response_format: { type: "json_object" },
};

// A complex prompt that classifies to the PREMIUM lane (same signal routing.spec
// uses), streamed because the premium + economy lane heads are stream-only on the
// mock. Used as the OVER-budget probe so a degrade down to economy is observable.
const COMPLEX_STREAM = {
  model: "gpt-4o-mini",
  messages: [
    {
      role: "user",
      content:
        "Prove step by step the theorem and derive the integral, reason about the matrix equation and analyze the implications first then finally compile the proof.",
    },
  ],
  stream: true,
};

test.describe("per-key usage budget e2e", () => {
  test("degrade: over-budget request is served on the economy lane (not rejected)", async ({
    request,
  }) => {
    // 1st request (non-stream): cold bucket → served; settle awaited before return.
    const first = await request.post("/v1/chat/completions", { data: DEPLETE, headers: DEGRADE_AUTH });
    expect(first.status()).toBe(200);

    // 2nd request: budget exhausted → degraded to economy, STILL served (200).
    const second = await request.post("/v1/chat/completions", {
      data: COMPLEX_STREAM,
      headers: DEGRADE_AUTH,
    });
    expect(second.status()).toBe(200);
    expect(second.headers()["x-helm-lane"]).toBe("economy");
  });

  test("reject: over-budget request returns a structured 429", async ({ request }) => {
    // 1st request: served (full bucket); settle awaited before return.
    const first = await request.post("/v1/chat/completions", { data: DEPLETE, headers: REJECT_AUTH });
    expect(first.status()).toBe(200);

    // 2nd request: budget exhausted + reject behavior → 429, before routing.
    const second = await request.post("/v1/chat/completions", { data: DEPLETE, headers: REJECT_AUTH });
    expect(second.status()).toBe(429);
    expect(JSON.stringify(await second.json())).toContain("rate_limited");
  });
});
