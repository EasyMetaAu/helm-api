import { expect, test } from "@playwright/test";
import { FAIL_PRIMARY_SENTINEL } from "./fixtures/mock-upstream.js";

// e2e.routing — black-box the WHOLE routing pipeline (Auth → Protocol →
// Classifier → Policy → Lane → Capability → Breaker → Executor → Telemetry)
// over real HTTP into a real gateway + a deterministic mock upstream. We assert
// the FINAL lane / model the pipeline landed on, read from gateway debug headers
// (`x-helm-lane` / `x-helm-final-model` / `x-helm-provider-model`) plus the
// echoed provider model in the mock's response body.
//
// Determinism (CI-safe): the mock upstream is fixed/offline, the key is
// pre-seeded, and every prompt is chosen to hit the LAYER-1 RULE classifier
// (eval is OFF) so the selected lane is reproducible. See task e2e.routing.

const TEST_KEY = "helm_live_e2e_testkey";
const AUTH = { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" };

// DEFAULT_LANES candidate aliases per lane (post chain-expansion head). The
// router resolves an alias which the executor sends to the upstream; the mock
// echoes it back as `model`.
const ECONOMY_HEAD = "cheap_model";
const PREMIUM_HEAD = "best_reasoning_model";
const BALANCED_HEAD = "default_good_model";

function chat(content: string, extra: Record<string, unknown> = {}) {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content }],
    stream: false,
    ...extra,
  };
}

test.describe("routing e2e", () => {
  // ── Scenario 1: simple prompt → economy lane ────────────────────────────────
  test("simple prompt -> economy lane", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat("translate this sentence to french: hello"),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("economy");
    // final model is the economy head and is echoed back by the mock.
    expect(res.headers()["x-helm-final-model"]).toBe(ECONOMY_HEAD);
    const body = await res.json();
    expect(body.model).toBe(ECONOMY_HEAD);
  });

  // ── Scenario 2: complex prompt → premium lane ───────────────────────────────
  test("complex prompt -> premium lane", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat(
        "Prove step by step the theorem and derive the integral, reason about the matrix equation and analyze the implications first then finally compile the proof.",
      ),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("premium");
    expect(res.headers()["x-helm-final-model"]).toBe(PREMIUM_HEAD);
    const body = await res.json();
    expect(body.model).toBe(PREMIUM_HEAD);
  });

  // ── Scenario 3: response_format=json_object → routes + valid JSON shape ──────
  // DEFAULT_LANES has no dedicated `json` lane; the json constraint flows through
  // the pipeline (extraction task) and MUST land on a valid lane without 5xx,
  // and the upstream response is a well-formed JSON object. See deviations.
  test("response_format=json_object -> routed, valid JSON, no 5xx", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat("extract the fields and parse json from this text", {
        response_format: { type: "json_object" },
      }),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    // routed to a real lane (capability filter is fail-open with an empty catalog).
    const lane = res.headers()["x-helm-lane"];
    expect(["economy", "balanced", "premium"]).toContain(lane);
    const body = await res.json();
    // well-formed chat.completion JSON object.
    expect(typeof body).toBe("object");
    expect(body).toHaveProperty("choices");
  });

  // ── Scenario 4: primary provider error → EXECUTION fallback serves ──────────
  // Mock injects a one-shot 5xx for the economy head (`cheap_model`); the chain's
  // NEXT candidate (`default_good_model`, via economy→balanced) must serve. Lane
  // stays `economy` (execution fallback ≠ classification fallback, principle 5).
  test("primary provider error -> fallback model serves (execution fallback)", async ({
    request,
  }) => {
    // The prompt routes to economy (simple) AND carries the fail sentinel so the
    // mock 5xxs the economy head (`cheap_model`). The gateway only forwards
    // model+messages upstream, so the fault is steered through the prompt.
    const res = await request.post("/v1/chat/completions", {
      data: chat(`translate this sentence to french: hola ${FAIL_PRIMARY_SENTINEL}`),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    // lane unchanged: this is EXECUTION fallback, not classification fallback.
    expect(res.headers()["x-helm-lane"]).toBe("economy");
    // final model is the in-chain NEXT candidate, not the failed primary.
    const finalModel = res.headers()["x-helm-final-model"];
    expect(finalModel).not.toBe(ECONOMY_HEAD);
    expect(finalModel).toBe(BALANCED_HEAD);
    const body = await res.json();
    expect(body.model).toBe(BALANCED_HEAD);
  });

  // ── Scenario 5: unclassifiable prompt → balanced (classification fallback) ──
  // A contentless/degenerate prompt is genuinely unclassifiable: the classify
  // adapter fails open (principle 3) and the resolver pins `balanced` via the
  // classification-fallback path (principle 5). MUST NOT 5xx.
  test("unclassifiable prompt -> balanced lane (classification fallback)", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat("   "),
      headers: AUTH,
    });
    // fail-open: never a 5xx for a classification failure.
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("balanced");
    expect(res.headers()["x-helm-final-model"]).toBe(BALANCED_HEAD);
  });
});
