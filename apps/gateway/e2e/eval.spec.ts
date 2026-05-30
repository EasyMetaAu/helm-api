import { expect, test } from "@playwright/test";
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
// HELM_E2E in the test-server; production config stays fail-closed). The
// "ambiguous" prompt is chosen so Layer-1 rules are UNCERTAIN (confidence below
// threshold) — that is what lets Layer-2 eval (or its disabled/timeout fallback)
// decide. See task e2e.eval + implementation-notes.

const TEST_KEY = "helm_live_e2e_testkey";
const MOCK_PORT = process.env.MOCK_PORT ?? "8181";
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

// Raise the Layer-1 gate so the deliberately AMBIGUOUS prompts (rules confidence
// ~0.53) fall BELOW it and reach Layer-2 eval, while the STRONG prompt (~0.98)
// still hit-stops. The deterministic Layer-1 sigmoid never dips below 0.5, so a
// black-box eval test MUST raise the gate. e2e-only header (HELM_E2E); production
// classification stays config-driven. Sent on EVERY eval-spec request so the
// shared gateway's other specs (routing) keep the config default 0.45.
const AUTH = {
  Authorization: `Bearer ${TEST_KEY}`,
  "Content-Type": "application/json",
  "x-helm-rules-threshold": "0.7",
};

// DEFAULT_LANES candidate heads.
const BALANCED_HEAD = "default_good_model";
const PREMIUM_HEAD = "best_reasoning_model";

// An intentionally ambiguous prompt: no strong Layer-1 keyword signal, so rules
// stay UNCERTAIN (confidence below the e2e threshold) and the cascade must
// consult Layer 2 (when enabled) or fall open to balanced (when disabled / on
// timeout). The gateway's eval cache is process-local and persists ACROSS tests,
// so each test mints a UNIQUE-but-still-ambiguous prompt (via `ambiguous(tag)`)
// to avoid cross-test cache bleed — content-hash keying keeps them distinct.
const AMBIGUOUS = "Hmm, I was wondering about that thing we mentioned earlier, what do you reckon?";

function ambiguous(tag: string): string {
  // Append a neutral, non-keyword tag so the content-hash differs per test while
  // the Layer-1 rules verdict stays low-confidence (the tag adds no signal).
  return `${AMBIGUOUS} (ref ${tag})`;
}

function chat(content: string, extra: Record<string, unknown> = {}) {
  return { model: "gpt-4o-mini", messages: [{ role: "user", content }], stream: false, ...extra };
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
      headers: AUTH, // no x-helm-eval header → eval stays OFF (default)
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
      data: chat(ambiguous("s2")),
      headers: { ...AUTH, "x-helm-eval": "on" },
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
      headers: { ...AUTH, "x-helm-eval": "on" },
    });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-helm-eval-cache-hit"]).toBe("false");
    expect(await evalCalls(request)).toBe(1);

    const second = await request.post("/v1/chat/completions", {
      data: chat(prompt),
      headers: { ...AUTH, "x-helm-eval": "on" },
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
      headers: { ...AUTH, "x-helm-eval": "on" },
    });
    expect(first.status()).toBe(200);
    expect(await evalCalls(request)).toBe(1);

    const second = await request.post("/v1/chat/completions", {
      data: chat(ambiguous("s4b")),
      headers: { ...AUTH, "x-helm-eval": "on" },
    });
    expect(second.status()).toBe(200);
    expect(second.headers()["x-helm-eval-cache-hit"]).toBe("false");
    // content-hash key distinguishes the two prompts → a fresh eval call.
    expect(await evalCalls(request)).toBe(2);
  });

  // ── Scenario 5: eval timeout → balanced (fail-open, HTTP 200) ──────────────
  test("eval timeout -> request still 200, falls open to balanced", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      // the slow sentinel makes the eval stand-in delay past timeout_ms.
      data: chat(`${ambiguous("s5")} ${EVAL_SLOW_SENTINEL}`),
      headers: { ...AUTH, "x-helm-eval": "on" },
    });
    // fail-open: the main path is NEVER dragged down to a 5xx.
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("balanced");
    expect(res.headers()["x-helm-final-model"]).toBe(BALANCED_HEAD);
    expect(res.headers()["x-helm-decided-by"]).toBe("fallback");
    expect(res.headers()["x-helm-fallback-reason"]).toBe("eval_timeout");
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
      headers: { ...AUTH, "x-helm-eval": "on" }, // eval ON, but rules win first
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-decided-by"]).toBe("rules");
    expect(res.headers()["x-helm-lane"]).toBe("premium");
    // hit-stop saved the cost: eval endpoint never called even though eval is ON.
    expect(await evalCalls(request)).toBe(0);
  });

  // ── Scenario 7: fail-open does NOT poison the cache ────────────────────────
  test("timeout fail-open is not cached -> a repeat re-calls the eval endpoint", async ({
    request,
  }) => {
    const slowPrompt = `${ambiguous("s7")} ${EVAL_SLOW_SENTINEL}`;
    const first = await request.post("/v1/chat/completions", {
      data: chat(slowPrompt),
      headers: { ...AUTH, "x-helm-eval": "on" },
    });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-helm-fallback-reason"]).toBe("eval_timeout");
    const afterFirst = await evalCalls(request);
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    const second = await request.post("/v1/chat/completions", {
      data: chat(slowPrompt),
      headers: { ...AUTH, "x-helm-eval": "on" },
    });
    expect(second.status()).toBe(200);
    expect(second.headers()["x-helm-fallback-reason"]).toBe("eval_timeout");
    // the failed result was NOT cached → the endpoint is hit again (no permanent
    // wedge on a transient blip, CLAUDE.md principle 3).
    expect(await evalCalls(request)).toBeGreaterThan(afterFirst);
  });
});
