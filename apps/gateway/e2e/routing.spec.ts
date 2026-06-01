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

// Shipped config/lanes.yaml candidate aliases per lane (post chain-expansion
// head). The router resolves an alias which the executor sends to the upstream
// (the resolved provider_model == the alias, by the alias-namespace convention);
// the mock echoes it back as `model`. Keep these in lockstep with the lane
// primaries in config/lanes.yaml.
const ECONOMY_HEAD = "openai-crs/gpt-5.4-mini";
const PREMIUM_HEAD = "openai-crs/gpt-5.5";
const BALANCED_HEAD = "deepseek-crs/deepseek-pro";
// economy chain = [openai-crs/gpt-5.4-mini, deepseek-crs/deepseek-flash,
// balanced...]; the in-chain candidate AFTER the economy head is the one that
// serves when the head is fault-injected (scenario 4, EXECUTION fallback).
const ECONOMY_NEXT = "deepseek-crs/deepseek-flash";

// The upstream WIRE model ids the gateway actually sends (config/providers.yaml
// `provider_model`), which the mock echoes back verbatim in the response `model`
// field. Since fix-upstream-model-id decoupled alias from wire id, body.model is
// the bare wire id; the routing ALIAS is surfaced separately via the
// `x-helm-final-model` header (asserted above each body.model check).
const ECONOMY_HEAD_WIRE = "gpt-5.4-mini";
const PREMIUM_HEAD_WIRE = "gpt-5.5";
const ECONOMY_NEXT_WIRE = "deepseek-flash";

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
  // The economy head (openai-crs/gpt-5.4-mini) is STREAM-ONLY on the relay
  // (capabilities.yaml requiresStreaming:true), so exercise it with a STREAMING
  // request — a non-stream request would (correctly) skip the head with
  // skip_reason no_nonstream_support and fall to the next in-chain candidate
  // (covered by the non-stream paths elsewhere). Routing is asserted via the
  // debug headers, which the gateway emits BEFORE the SSE body; the resolved bare
  // wire id is surfaced separately as x-helm-provider-model.
  test("simple prompt -> economy lane", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      // Clearly-simple: strong simple-keyword signals (hi/thanks/ok) push the
      // score well below the `standard` boundary -> confident `simple` -> economy.
      data: chat("hi thanks, translate to spanish: ok", { stream: true }),
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-helm-lane"]).toBe("economy");
    // final model is the economy head; its resolved provider_model is the bare id.
    expect(res.headers()["x-helm-final-model"]).toBe(ECONOMY_HEAD);
    expect(res.headers()["x-helm-provider-model"]).toBe(ECONOMY_HEAD_WIRE);
  });

  // ── Scenario 2: complex prompt → premium lane ───────────────────────────────
  // Premium head (openai-crs/gpt-5.5) is likewise stream-only — exercise via streaming.
  test("complex prompt -> premium lane", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      data: chat(
        "Prove step by step the theorem and derive the integral, reason about the matrix equation and analyze the implications first then finally compile the proof.",
        { stream: true },
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
  // Mock injects a one-shot 5xx for the economy head (`openai-crs/gpt-5.4-mini`);
  // the chain's NEXT candidate (`deepseek-crs/deepseek-flash`) must serve. Lane
  // stays `economy` (execution fallback ≠ classification fallback, principle 5).
  test("primary provider error -> fallback model serves (execution fallback)", async ({
    request,
  }) => {
    // The prompt routes to economy (simple) AND carries the fail sentinel so the
    // mock 5xxs the economy head. The gateway only forwards model+messages
    // upstream, so the fault is steered through the prompt. STREAMING so the
    // stream-only economy head is actually INVOKED (and then 5xxs) — a non-stream
    // request would skip the head on capability grounds and never exercise the
    // upstream-error fallback this scenario is about.
    const res = await request.post("/v1/chat/completions", {
      // Same clearly-simple economy prompt as scenario 1, plus the fail sentinel.
      data: chat(`hi thanks, translate to spanish: ok ${FAIL_PRIMARY_SENTINEL}`, { stream: true }),
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
