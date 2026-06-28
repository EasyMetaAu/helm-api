import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, basicHeader } from "./fixtures/admin.js";
import {
  EVAL_CALL_COUNT_PATH,
  EVAL_RESET_PATH,
  EVAL_SLOW_SENTINEL,
} from "./fixtures/mock-upstream.js";

// e2e.eval — black-box the Layer-2 eval cascade over real HTTP into a real
// gateway + a deterministic mock upstream that doubles as a controllable
// "eval small-model" stand-in. We assert EXTERNALLY observable behavior only:
//   • the classification landed on the right lane,
//   • the decision-source fields are correct (x-helm-decided-by /
//     x-helm-fallback-reason / x-helm-eval-cache-hit),
//   • the eval model endpoint was (or was NOT) called the right number of times
//     (the hardest cache-hit evidence),
//   • timeout / disabled paths NEVER 5xx and fall open to `balanced`.
//
// Determinism (CI-safe): the mock is offline/fixed, the key is pre-seeded, eval
// is toggled per-request via the e2e-only `x-helm-eval` header (gated by
// HELM_E2E in the test-server; production config stays fail-closed). These
// scenarios exercise the EVAL CASCADE (disabled→fallback / enabled→eval-decides /
// timeout→fallback), NOT the exact Layer-1 calibration — so the uncertain-path
// requests FORCE Layer-1 uncertainty with the e2e-only `x-helm-rules-threshold`
// header (UNCERTAIN below). This decouples the eval tests from the classifier
// weights: the lane-calibration (2026-06-01) raised the ambiguous prompt's
// confidence to ~0.41 — still under the shipped 0.42 gate, but too thin a margin
// to depend on. The STRONG prompt (scenario 6, ~1.0) still hit-stops at the
// default threshold. See implementation-notes (classifier.lane-calibration).

const TEST_KEY = "helm_live_e2e_testkey";
const MOCK_PORT = process.env.MOCK_PORT ?? "8181";
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

const AUTH = {
  Authorization: `Bearer ${TEST_KEY}`,
  "Content-Type": "application/json",
};

// Eval-cascade scenarios force Layer-1 to be UNCERTAIN (rules threshold raised to
// 0.99 via the e2e-only header) so the cascade MUST fall through to Layer-2 (or
// its disabled/timeout fallback). This keeps the eval tests deterministic and
// independent of the classifier calibration. Scenario 6 (STRONG, rules hit-stop)
// deliberately omits this and runs at the shipped default threshold.
const UNCERTAIN = { ...AUTH, "x-helm-rules-threshold": "0.99" };

// Shipped config/lanes.yaml candidate heads (alias-namespace alignment,
// 2026-05-31). Keep in lockstep with config/lanes.yaml `balanced`/`premium`
// primaries.
// These e2e run with NO subscription connected, so a lane's nominal `openai-codex/*`
// primary is SKIPPED (provider_unavailable) and the lane serves its first STATIC
// fallback. balanced serves deepseek/deepseek-v4-pro; premium's first mock-backed
// candidate is zenmux/gpt-5.5 (ZenMux is keyed in the e2e — it carries gpt-image-2),
// so the two lanes serve DIFFERENT models (also told apart by the x-helm-lane header).
const BALANCED_HEAD = "deepseek/deepseek-v4-pro";
const PREMIUM_HEAD = "zenmux/gpt-5.5";

// An intentionally ambiguous prompt: no strong Layer-1 keyword signal. Paired
// with the UNCERTAIN header (rules threshold 0.99) the cascade is guaranteed to
// stay uncertain and must consult Layer 2 (when enabled) or fall open to balanced
// (when disabled / on timeout). The gateway's eval cache is process-local and persists ACROSS tests,
// so each test mints a UNIQUE-but-still-ambiguous prompt (via `ambiguous(tag)`)
// to avoid cross-test cache bleed — content-hash keying keeps them distinct.
const AMBIGUOUS = "Hmm, I was wondering about that thing we mentioned earlier, what do you reckon?";

function ambiguous(tag: string): string {
  // Append a neutral, non-keyword tag so the content-hash differs per test while
  // the Layer-1 rules verdict stays low-confidence (the tag adds no signal).
  return `${AMBIGUOUS} (ref ${tag})`;
}

function chat(content: string, extra: Record<string, unknown> = {}) {
  return { model: "auto", messages: [{ role: "user", content }], stream: false, ...extra };
}

// Read + reset the mock's eval-endpoint call counter (the hardest external
// evidence for cache hits / hit-stop). Absolute URL: the counter lives on the
// mock, not the gateway baseURL.
async function evalCalls(request: import("@playwright/test").APIRequestContext): Promise<number> {
  const res = await request.get(`${MOCK_BASE}${EVAL_CALL_COUNT_PATH}`);
  const body = await res.json();
  return body.count as number;
}
async function resetEval(request: import("@playwright/test").APIRequestContext): Promise<void> {
  await request.post(`${MOCK_BASE}${EVAL_RESET_PATH}`);
}

test.describe("eval cascade e2e", () => {
  test.beforeEach(async ({ request }) => {
    await resetEval(request);
  });

  // ── Scenario 1: eval OFF (default) → uncertain rules → balanced ────────────
  test("eval disabled -> ambiguous request falls open to balanced, eval never called", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat(ambiguous("s1")),
      headers: UNCERTAIN, // no x-helm-eval header → eval stays OFF (default)
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("balanced");
    expect(res.headers()["x-helm-decided-by"]).toBe("fallback");
    expect(res.headers()["x-helm-fallback-reason"]).toBe("eval_disabled");
    // the eval small-model endpoint was never touched.
    expect(await evalCalls(request)).toBe(0);
  });

  // ── Scenario 2: eval ON → eval decides the lane ────────────────────────────
  test("eval enabled -> eval output picks the lane (not balanced fallback)", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      // The eval verdict picks the premium LANE; premium's openai-codex head is
      // skipped (no subscription) so it serves the static fallback PREMIUM_HEAD.
      // The internal eval call is a separate non-stream classify request.
      data: chat(ambiguous("s2")),
      headers: { ...UNCERTAIN, "x-helm-eval": "on" },
    });
    expect(res.status()).toBe(200);
    // the eval stand-in returns complexity=reasoning -> premium lane (NOT balanced).
    expect(res.headers()["x-helm-decided-by"]).toBe("eval");
    expect(res.headers()["x-helm-lane"]).toBe("premium");
    expect(res.headers()["x-helm-final-model"]).toBe(PREMIUM_HEAD);
    expect(res.headers()["x-helm-eval-cache-hit"]).toBe("false");
    expect(await evalCalls(request)).toBe(1);
  });

  // ── Scenario 3: identical repeat → cache hit, eval NOT re-called ────────────
  test("identical repeat -> eval cache hit, endpoint call count does not grow", async ({
    request,
  }) => {
    const prompt = ambiguous("s3");
    const first = await request.post("/v1/chat/completions", {
      data: chat(prompt),
      headers: { ...UNCERTAIN, "x-helm-eval": "on" },
    });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-helm-eval-cache-hit"]).toBe("false");
    expect(await evalCalls(request)).toBe(1);

    const second = await request.post("/v1/chat/completions", {
      data: chat(prompt),
      headers: { ...UNCERTAIN, "x-helm-eval": "on" },
    });
    expect(second.status()).toBe(200);
    expect(second.headers()["x-helm-lane"]).toBe("premium");
    expect(second.headers()["x-helm-decided-by"]).toBe("eval");
    expect(second.headers()["x-helm-eval-cache-hit"]).toBe("true");
    // HARD evidence: the eval endpoint was NOT called a second time.
    expect(await evalCalls(request)).toBe(1);
  });

  // ── Scenario 4: different content → no cache cross-contamination ────────────
  test("different content -> cache miss, eval endpoint count increments", async ({ request }) => {
    const first = await request.post("/v1/chat/completions", {
      data: chat(ambiguous("s4a")),
      headers: { ...UNCERTAIN, "x-helm-eval": "on" },
    });
    expect(first.status()).toBe(200);
    expect(await evalCalls(request)).toBe(1);

    const second = await request.post("/v1/chat/completions", {
      data: chat(ambiguous("s4b")),
      headers: { ...UNCERTAIN, "x-helm-eval": "on" },
    });
    expect(second.status()).toBe(200);
    expect(second.headers()["x-helm-eval-cache-hit"]).toBe("false");
    // content-hash key distinguishes the two prompts → a fresh eval call.
    expect(await evalCalls(request)).toBe(2);
  });

  // ── Scenario 5: eval timeout → balanced (fail-open, HTTP 200) ──────────────
  test("eval too slow -> request still 200, falls open to balanced", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      // The slow sentinel makes the eval stand-in delay past the PER-CANDIDATE deadline
      // (eval.timeout_ms). The eval loopback's executor times the candidate out and, with
      // only one eval candidate in the hermetic e2e, the chain exhausts → the eval call
      // fails → fail-open to balanced. (In production eval.model is a LANE, so the
      // per-candidate timeout instead falls back to the next candidate and the eval
      // SUCCEEDS — see execute.test withAttemptDeadline + classifier-samples.) Either
      // way the contract guarded here holds: the main path is NEVER dragged to a 5xx.
      data: chat(`${ambiguous("s5")} ${EVAL_SLOW_SENTINEL}`),
      headers: { ...UNCERTAIN, "x-helm-eval": "on" },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("balanced");
    expect(res.headers()["x-helm-final-model"]).toBe(BALANCED_HEAD);
    expect(res.headers()["x-helm-decided-by"]).toBe("fallback");
    expect(res.headers()["x-helm-fallback-reason"]).toBe("eval_provider_error");
  });

  // ── Scenario 6: rules high-confidence → hit-stop, eval never consulted ─────
  test("rules high-confidence -> decided_by=rules, eval endpoint not called", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      // a strongly-keyworded prompt → Layer-1 rules are confident → hit-stop.
      data: chat(
        "Prove step by step the theorem and derive the integral, reason about the matrix equation and analyze the implications first then finally compile the proof.",
      ),
      headers: { ...AUTH, "x-helm-eval": "on" }, // eval ON at DEFAULT threshold, but rules win first
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-decided-by"]).toBe("rules");
    expect(res.headers()["x-helm-lane"]).toBe("premium");
    // hit-stop saved the cost: eval endpoint never called even though eval is ON.
    expect(await evalCalls(request)).toBe(0);
  });

  // ── Scenario 8: admin classifier edit HOT-APPLIES to routing (no restart) ──
  // The headline of admin.classifier-hotapply: flip eval.enabled via the admin API
  // and a SUBSEQUENT classification (sent WITHOUT the e2e x-helm-eval header, so it
  // is purely config-driven) reflects the change. Flipping it back proves the eval
  // cache is invalidated too (a previously-evaluated prompt is re-decided under the
  // new config instead of serving the stale verdict).
  test("PUT classifier via admin -> next classification reflects eval toggle without restart", async ({
    request,
  }) => {
    const ADMIN = { Authorization: basicHeader(ADMIN_USER, ADMIN_PASSWORD) };
    // Read the live classifier config, then PUT it back with eval ENABLED.
    const current = await (await request.get("/admin/api/classifier", { headers: ADMIN })).json();
    const enableRes = await request.put("/admin/api/classifier", {
      headers: { ...ADMIN, "Content-Type": "application/json" },
      data: { ...current, eval: { ...current.eval, enabled: true } },
    });
    expect(enableRes.status()).toBe(200);

    const prompt = ambiguous("s8");
    // No x-helm-eval header -> eval enablement comes purely from the (hot-applied)
    // config. eval now decides -> premium lane.
    const afterEnable = await request.post("/v1/chat/completions", {
      data: chat(prompt),
      headers: UNCERTAIN,
    });
    expect(afterEnable.status()).toBe(200);
    expect(afterEnable.headers()["x-helm-decided-by"]).toBe("eval");
    expect(afterEnable.headers()["x-helm-lane"]).toBe("premium");

    // Now DISABLE eval via the admin API. The cache built under the prior config
    // must be dropped: the SAME prompt must re-decide and fall open to balanced.
    const disableRes = await request.put("/admin/api/classifier", {
      headers: { ...ADMIN, "Content-Type": "application/json" },
      data: { ...current, eval: { ...current.eval, enabled: false } },
    });
    expect(disableRes.status()).toBe(200);

    const afterDisable = await request.post("/v1/chat/completions", {
      data: chat(prompt),
      headers: UNCERTAIN,
    });
    expect(afterDisable.status()).toBe(200);
    // eval is OFF now -> uncertain falls open to balanced (NOT the stale premium).
    expect(afterDisable.headers()["x-helm-lane"]).toBe("balanced");
    expect(afterDisable.headers()["x-helm-decided-by"]).toBe("fallback");
    expect(afterDisable.headers()["x-helm-fallback-reason"]).toBe("eval_disabled");

    // Restore eval OFF baseline for any later specs sharing this gateway.
    await request.put("/admin/api/classifier", {
      headers: { ...ADMIN, "Content-Type": "application/json" },
      data: { ...current, eval: { ...current.eval, enabled: false } },
    });
  });

  // ── Scenario 7: fail-open does NOT poison the cache ────────────────────────
  test("timeout fail-open is not cached -> a repeat re-calls the eval endpoint", async ({
    request,
  }) => {
    const slowPrompt = `${ambiguous("s7")} ${EVAL_SLOW_SENTINEL}`;
    const first = await request.post("/v1/chat/completions", {
      data: chat(slowPrompt),
      headers: { ...UNCERTAIN, "x-helm-eval": "on" },
    });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-helm-fallback-reason"]).toBe("eval_provider_error");
    const afterFirst = await evalCalls(request);
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    const second = await request.post("/v1/chat/completions", {
      data: chat(slowPrompt),
      headers: { ...UNCERTAIN, "x-helm-eval": "on" },
    });
    expect(second.status()).toBe(200);
    expect(second.headers()["x-helm-fallback-reason"]).toBe("eval_provider_error");
    // the failed result was NOT cached → the endpoint is hit again (no permanent
    // wedge on a transient blip, CLAUDE.md principle 3).
    expect(await evalCalls(request)).toBeGreaterThan(afterFirst);
  });
});
