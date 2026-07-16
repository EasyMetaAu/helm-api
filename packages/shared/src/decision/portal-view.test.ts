import { describe, expect, it } from "vitest";
import { toPortalDecisionView } from "./portal-view.js";
import type { DecisionRecord } from "./schema.js";

// A record loaded with EVERY supply-chain / internal-reasoning field the portal
// must NOT leak (spec §4.3 / §8 R7). The whitelist projection is the load-bearing
// redaction: a black-list leaks the moment a field is added, so this test pins the
// contract "provider alias / internal model id / routing topology never appear in
// portal output" by deep-scanning the serialized view for the poison strings.
function poisonedRecord(): DecisionRecord {
  return {
    request_id: "req_1",
    trace_id: "trace_1",
    requested_model: "auto",
    protocol: "openai_chat",
    key_prefix: "helm_live_ab12",
    classifier: {
      task_type: "coding",
      complexity: "high",
      confidence: 0.95,
      decided_by: "eval",
      rules_confidence: 0.05,
      eval_cache_hit: false,
      eval_model: "SECRET_EVAL_MODEL", // internal small-model id — must NOT leak
      eval_latency_ms: 42,
      fallback_reason: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: "pol_internal_1", reason: "SECRET_POLICY_REASON" },
    lane: {
      selected_lane: "balanced",
      candidate_chain: ["SECRET_ALIAS_A", "SECRET_ALIAS_B"], // provider aliases — must NOT leak
    },
    provider_attempts: [
      {
        alias: "SECRET_ALIAS_A",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 1200,
        cost_usd: 0.01,
        error_detail: null,
        provider_name: "SECRET_PROVIDER", // supply chain — must NOT leak
        provider_model: "SECRET_WIRE_MODEL", // wire model — must NOT leak
      },
    ],
    final: {
      model_alias: "gpt-5.5", // served model — OK to show
      provider_model: "SECRET_WIRE_MODEL", // internal — must NOT leak
      status: "ok",
      error_reason: null,
    },
    serving_account: { provider_id: "SECRET_PROVIDER_ID", account: "SECRET_ACCOUNT" },
    latency_total_ms: 1200,
    fallback_count: 0,
    cost_breakdown: { eval_usd: 0.0001, completion_usd: 0.01, total_usd: 0.0101 },
    memory: null,
    usage: {
      measurement: "reported",
      cost_basis: null,
      prompt_tokens: 100,
      completion_tokens: 50,
      cached_tokens: 0,
      cache_creation_tokens: 0,
      service_tier: "SECRET_TIER",
      inference_geo: "SECRET_GEO",
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      audio_prompt_tokens: 0,
      cached_audio_prompt_tokens: 0,
      image_output_tokens: 0,
      billed_cost_usd: 0.01,
    },
    stream_outcome: "completed",
    generation_ms: 800,
  };
}

const POISON = [
  "SECRET_EVAL_MODEL",
  "SECRET_POLICY_REASON",
  "SECRET_ALIAS_A",
  "SECRET_ALIAS_B",
  "SECRET_PROVIDER",
  "SECRET_WIRE_MODEL",
  "SECRET_PROVIDER_ID",
  "SECRET_ACCOUNT",
  "SECRET_TIER",
  "SECRET_GEO",
];

describe("toPortalDecisionView", () => {
  it("never leaks any provider alias / internal model id / routing topology", () => {
    const view = toPortalDecisionView(poisonedRecord());
    const serialized = JSON.stringify(view);
    for (const poison of POISON) {
      expect(serialized).not.toContain(poison);
    }
  });

  it("exposes the lane/result view the user is entitled to", () => {
    const view = toPortalDecisionView(poisonedRecord());
    expect(view.request_id).toBe("req_1");
    expect(view.trace_id).toBe("trace_1");
    expect(view.requested_model).toBe("auto");
    expect(view.served_model).toBe("gpt-5.5"); // final.model_alias — user-facing
    expect(view.lane).toBe("balanced");
    expect(view.status).toBe("ok");
    expect(view.latency_ms).toBe(1200);
    expect(view.cost_usd).toBe(0.0101);
    expect(view.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      cached_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  it("surfaces a redacted error message but not the internal error_reason topology", () => {
    const rec = poisonedRecord();
    rec.final = {
      model_alias: "gpt-5.5",
      provider_model: "SECRET_WIRE_MODEL",
      status: "error",
      error_reason: "all_providers_failed",
    };
    const view = toPortalDecisionView(rec);
    expect(view.status).toBe("error");
    // error_reason is a terminal error CLASS (not a provider identity) → OK to show.
    expect(view.error_reason).toBe("all_providers_failed");
    expect(JSON.stringify(view)).not.toContain("SECRET_WIRE_MODEL");
  });
});
