import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, basicHeader } from "./fixtures/admin.js";
import { FAIL_PRIMARY_SENTINEL } from "./fixtures/mock-upstream.js";

// e2e.routing — black-box the WHOLE routing pipeline (Auth → Protocol →
// Classifier → Policy → Lane → Capability → Breaker → Executor → Telemetry)
// over real HTTP into a real gateway + a deterministic mock upstream. We assert
// the FINAL lane / model the pipeline landed on, read from gateway debug headers
// (`x-helm-lane` / `x-helm-final-model` / `x-helm-provider-model`) plus the
// echoed provider model in the mock's response body.
//
// Determinism (CI-safe): the mock upstream is fixed/offline, the key is
// pre-seeded, and every prompt is chosen to be CLEARLY-TYPED so Layer-1 rules
// hit-stop with confidence ABOVE the default 0.42 gate (eval is OFF) and the
// selected lane is reproducible. After classifier.confidence-fix a boundary-
// hugging prompt would instead fall open to `balanced`, so these prompts lean on
// strong simple/reasoning signals to stay far from the tier boundaries. See task
// e2e.routing + implementation-notes (classifier.confidence-fix).

const TEST_KEY = "helm_live_e2e_testkey";
const AUTH = { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" };

// NO-SUBSCRIPTION FAIL-OPEN (the CI reality). Keep configured subscription
// primaries distinct from the keyed static models that actually execute when no
// OAuth account is bound.
const ECONOMY_CONFIGURED_PRIMARY = "gpt-5.6-luna";
const PREMIUM_CONFIGURED_PRIMARY = "gpt-5.6-sol";
const BALANCED_CONFIGURED_PRIMARY = "gpt-5.6-terra";
const ECONOMY_EXECUTION_FALLBACK = "openrouter/deepseek-v4-flash";
const QUALITY_EXECUTION_FALLBACK = "openrouter/deepseek-v4-pro";
// Paid OpenAI aliases are absent from shipped lanes but deliberately remain
// available to a custom-model key as explicit, operator-controlled targets.
const EXPLICIT_DIRECT_OPENAI_ALIAS = "openai/gpt-5.6-luna";
const EXPLICIT_DIRECT_OPENAI_WIRE = "gpt-5.6-luna";
// After the first executable economy candidate returns 5xx, the OpenRouter
// mirror is the next keyed static candidate.
const ECONOMY_NEXT = "openrouter/auto";

// The upstream WIRE model ids the gateway sends (config/providers.yaml
// `provider_model`), echoed back by the mock as `model`.
// The routing ALIAS is surfaced separately via `x-helm-final-model`.
const ECONOMY_EXECUTION_FALLBACK_WIRE = "deepseek/deepseek-v4-flash";
const QUALITY_EXECUTION_FALLBACK_WIRE = "deepseek/deepseek-v4-pro";
const ECONOMY_NEXT_WIRE = "openrouter/auto";

async function expectConfiguredLanePrimary(
  request: import("@playwright/test").APIRequestContext,
  lane: string,
  primary: string,
): Promise<void> {
  const res = await request.get(`/admin/api/lanes/${lane}`, {
    headers: { Authorization: basicHeader(ADMIN_USER, ADMIN_PASSWORD) },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).primary).toBe(primary);
}

function chat(content: string, extra: Record<string, unknown> = {}) {
  return {
    model: "auto",
    messages: [{ role: "user", content }],
    stream: false,
    ...extra,
  };
}

test.describe("routing e2e", () => {
  // ── Scenario 1: simple prompt → economy lane ────────────────────────────────
  // The configured economy primary remains Codex Luna. With no subscription
  // connected in e2e, Codex/Anthropic aliases are skipped and DeepSeek Flash is
  // the first executable static fallback.
  test("simple prompt -> economy lane", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      // Clearly-simple: strong simple-keyword signals (hi/thanks/ok) push the
      // score well below the `standard` boundary -> confident `simple` -> economy.
      data: chat("hi thanks, translate to spanish: ok"),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("economy");
    await expectConfiguredLanePrimary(request, "economy", ECONOMY_CONFIGURED_PRIMARY);
    expect(res.headers()["x-helm-final-model"]).toBe(ECONOMY_EXECUTION_FALLBACK);
    expect(res.headers()["x-helm-provider-model"]).toBe(ECONOMY_EXECUTION_FALLBACK_WIRE);
  });

  // ── Scenario 2: complex prompt → premium lane ───────────────────────────────
  // Premium's configured primary is Codex Sol. With no OAuth accounts, its
  // Codex/xAI/Anthropic candidates skip and DeepSeek Pro serves from balanced.
  test("complex prompt -> premium lane", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat(
        "Prove step by step the theorem and derive the integral, reason about the matrix equation and analyze the implications first then finally compile the proof.",
      ),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("premium");
    await expectConfiguredLanePrimary(request, "premium", PREMIUM_CONFIGURED_PRIMARY);
    expect(res.headers()["x-helm-final-model"]).toBe(QUALITY_EXECUTION_FALLBACK);
    expect(res.headers()["x-helm-provider-model"]).toBe(QUALITY_EXECUTION_FALLBACK_WIRE);
  });

  // ── Scenario 3: response_format=json_object → json lane + valid JSON shape ───
  // The shipped config/policies.yaml has a `needs_json -> json` first-match rule
  // and config/lanes.yaml defines the `json` task lane, so a JSON-constrained
  // request now routes to the dedicated `json` lane (config.load-rules). The
  // upstream response is still a well-formed JSON object, no 5xx.
  test("response_format=json_object -> json lane, valid JSON, no 5xx", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      // Clearly-simple wording (no boundary-band ambiguity) so Layer-1 hit-stops
      // with high confidence; the `needs_json` policy (from response_format) then
      // selects the dedicated `json` lane. A boundary-hugging prompt would fall
      // open to `balanced` BEFORE the policy is consulted (resolver short-circuit
      // on decided_by=fallback), so the prompt is kept confidently `simple`.
      data: chat("hi thanks, ok", {
        response_format: { type: "json_object" },
      }),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    // routed to the json task lane via the needs_json policy.
    expect(res.headers()["x-helm-lane"]).toBe("json");
    const body = await res.json();
    // well-formed chat.completion JSON object.
    expect(typeof body).toBe("object");
    expect(body).toHaveProperty("choices");
  });

  // ── Scenario 4: primary provider error → EXECUTION fallback serves ──────────
  // Mock injects a 5xx for DeepSeek Flash, the first executable candidate after
  // the unavailable subscription aliases. The OpenRouter mirror then serves.
  // Lane stays `economy` (execution fallback ≠ classification fallback, principle 5).
  test("primary provider error -> fallback model serves (execution fallback)", async ({
    request,
  }) => {
    // The prompt routes to economy (simple) AND carries the fail sentinel so the
    // mock 5xxs the first executable DeepSeek candidate. The gateway only forwards
    // model+messages upstream, so the fault is steered through the prompt.
    const res = await request.post("/v1/chat/completions", {
      // Same clearly-simple economy prompt as scenario 1, plus the fail sentinel.
      data: chat(`hi thanks, translate to spanish: ok ${FAIL_PRIMARY_SENTINEL}`),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    // lane unchanged: this is EXECUTION fallback, not classification fallback.
    expect(res.headers()["x-helm-lane"]).toBe("economy");
    // final model is the in-chain NEXT candidate, not the failed primary.
    const finalModel = res.headers()["x-helm-final-model"];
    expect(finalModel).not.toBe(ECONOMY_EXECUTION_FALLBACK);
    expect(finalModel).toBe(ECONOMY_NEXT);
    expect(res.headers()["x-helm-provider-model"]).toBe(ECONOMY_NEXT_WIRE);
  });

  // ── Scenario 4b: explicit lane-as-model (allow_custom_model) ─────────────────
  // An allow_custom_model key may name a LANE in the model field: classification
  // is skipped and the lane's expanded chain executes (docs/04 explicit
  // model/lane). The auth header switches to the dedicated k_custom key.
  const CUSTOM_AUTH = {
    Authorization: "Bearer helm_live_e2e_custom",
    "Content-Type": "application/json",
  };
  const CAPPED_AUTH = {
    Authorization: "Bearer helm_live_e2e_custom_capped",
    "Content-Type": "application/json",
  };

  test("explicit lane-as-model -> lane chain serves (allow_custom_model)", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      // The prompt is clearly COMPLEX — if classification ran it would pick
      // premium; landing on economy proves the explicit lane bypassed it.
      data: chat("Prove step by step the theorem and derive the integral.", { model: "economy" }),
      headers: CUSTOM_AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("economy");
    await expectConfiguredLanePrimary(request, "economy", ECONOMY_CONFIGURED_PRIMARY);
    expect(res.headers()["x-helm-final-model"]).toBe(ECONOMY_EXECUTION_FALLBACK);
    expect(res.headers()["x-helm-provider-model"]).toBe(ECONOMY_EXECUTION_FALLBACK_WIRE);
  });

  test("explicit lane outside the key's allowed_lanes -> 400 invalid_request (no silent downgrade)", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat("hi thanks, ok", { model: "premium" }),
      headers: CAPPED_AUTH,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("premium");
  });

  test("explicit UNKNOWN model -> 400 invalid_request (strict, no Phase-0 fall-through)", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat("hi thanks, ok", { model: "totally-made-up-model" }),
      headers: CUSTOM_AUTH,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("totally-made-up-model");
  });

  test("explicit KNOWN model alias still passes through verbatim", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat("hi thanks, ok", { model: EXPLICIT_DIRECT_OPENAI_ALIAS }),
      headers: CUSTOM_AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-final-model"]).toBe(EXPLICIT_DIRECT_OPENAI_ALIAS);
    expect(res.headers()["x-helm-provider-model"]).toBe(EXPLICIT_DIRECT_OPENAI_WIRE);
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
    await expectConfiguredLanePrimary(request, "balanced", BALANCED_CONFIGURED_PRIMARY);
    expect(res.headers()["x-helm-final-model"]).toBe(QUALITY_EXECUTION_FALLBACK);
    expect(res.headers()["x-helm-provider-model"]).toBe(QUALITY_EXECUTION_FALLBACK_WIRE);
  });
});
