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
// pre-seeded, and every prompt is chosen to be CLEARLY-TYPED so Layer-1 rules
// hit-stop with confidence ABOVE the default 0.42 gate (eval is OFF) and the
// selected lane is reproducible. After classifier.confidence-fix a boundary-
// hugging prompt would instead fall open to `balanced`, so these prompts lean on
// strong simple/reasoning signals to stay far from the tier boundaries. See task
// e2e.routing + implementation-notes (classifier.confidence-fix).

const TEST_KEY = "helm_live_e2e_testkey";
const AUTH = { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" };

// NO-SUBSCRIPTION FAIL-OPEN (the CI reality). These e2e run with NO subscription
// connected, so the `openai-codex/*` lane heads (premium/coding/tool_use primaries
// in config/lanes.yaml) are NOT routable: the executor SKIPS them with
// skip_reason=provider_unavailable (never forwarding a prefixed id to the primary)
// and the lane falls open to its first STATIC fallback. So the model that actually
// SERVES each lane below is the deepseek/* (or zenmux/openrouter) static candidate,
// not the nominal openai-codex primary. With a subscription connected, the codex
// head would serve instead.
const ECONOMY_HEAD = "deepseek/deepseek-v4-flash"; // economy static primary serves
// premium's nominal primary is openai-codex/gpt-5.5 — skipped w/o a subscription,
// so premium serves its first static fallback, deepseek/deepseek-v4-pro.
const PREMIUM_HEAD = "deepseek/deepseek-v4-pro";
const BALANCED_HEAD = "deepseek/deepseek-v4-pro"; // balanced static primary serves
// economy chain = [deepseek/deepseek-v4-flash, openai-codex/gpt-5.4, balanced...].
// On fault injection (scenario 4) the economy head 5xxs, the next candidate
// openai-codex/gpt-5.4 is SKIPPED (no subscription), so the in-chain model that
// actually serves is balanced's primary, deepseek/deepseek-v4-pro.
const ECONOMY_NEXT = "deepseek/deepseek-v4-pro";

// The upstream WIRE model ids the gateway sends (config/providers.yaml
// `provider_model`), echoed back by the mock as `model`. All served candidates
// here are EXPLICIT deepseek/* entries, so the wire id is the bare provider_model.
// The routing ALIAS is surfaced separately via `x-helm-final-model`.
const ECONOMY_HEAD_WIRE = "deepseek-v4-flash";
const PREMIUM_HEAD_WIRE = "deepseek-v4-pro";
const ECONOMY_NEXT_WIRE = "deepseek-v4-pro";

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
  // The economy head (deepseek/deepseek-v4-flash) is json + non-stream capable, so
  // a plain non-stream request serves it directly. Routing is asserted via the
  // debug headers; the resolved bare wire id is surfaced as x-helm-provider-model.
  test("simple prompt -> economy lane", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      // Clearly-simple: strong simple-keyword signals (hi/thanks/ok) push the
      // score well below the `standard` boundary -> confident `simple` -> economy.
      data: chat("hi thanks, translate to spanish: ok"),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("economy");
    // final model is the economy head; its resolved provider_model is the bare id.
    expect(res.headers()["x-helm-final-model"]).toBe(ECONOMY_HEAD);
    expect(res.headers()["x-helm-provider-model"]).toBe(ECONOMY_HEAD_WIRE);
  });

  // ── Scenario 2: complex prompt → premium lane ───────────────────────────────
  // Premium's nominal primary (openai-codex/gpt-5.5) is the subscription channel;
  // with no subscription connected it is SKIPPED (provider_unavailable) and premium
  // fails open to its first static fallback, deepseek/deepseek-v4-pro. The lane is
  // still `premium` (asserted via the header) — only the served model is the
  // fallback.
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
    expect(res.headers()["x-helm-provider-model"]).toBe(PREMIUM_HEAD_WIRE);
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
  // Mock injects a one-shot 5xx for the economy head (`deepseek/deepseek-v4-flash`);
  // the next candidate `openai-codex/gpt-5.4` is skipped (no subscription), so the
  // first STATIC in-chain candidate that serves is `deepseek/deepseek-v4-pro`. Lane
  // stays `economy` (execution fallback ≠ classification fallback, principle 5).
  test("primary provider error -> fallback model serves (execution fallback)", async ({
    request,
  }) => {
    // The prompt routes to economy (simple) AND carries the fail sentinel so the
    // mock 5xxs the economy head. The gateway only forwards model+messages
    // upstream, so the fault is steered through the prompt. The economy head is
    // invoked (non-stream) and 5xxs, so the gateway falls forward past the skipped
    // codex candidate to the next static one — the upstream-error fallback this
    // scenario is about.
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
    expect(finalModel).not.toBe(ECONOMY_HEAD);
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
    expect(res.headers()["x-helm-final-model"]).toBe(ECONOMY_HEAD);
    expect(res.headers()["x-helm-provider-model"]).toBe(ECONOMY_HEAD_WIRE);
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
      data: chat("hi thanks, ok", { model: ECONOMY_HEAD }),
      headers: CUSTOM_AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-final-model"]).toBe(ECONOMY_HEAD);
    expect(res.headers()["x-helm-provider-model"]).toBe(ECONOMY_HEAD_WIRE);
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
