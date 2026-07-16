import type { ProviderAttempt } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { buildImageDecision } from "./image-telemetry.js";

function row(over: Partial<ProviderAttempt> & { alias: string }): ProviderAttempt {
  return {
    skipped: false,
    skip_reason: null,
    status: "ok",
    error_class: null,
    latency_ms: 0,
    cost_usd: null,
    error_detail: null,
    ...over,
  };
}

describe("buildImageDecision (chain-aware)", () => {
  it("records a fallback chain: served = the alias that actually served, fallback_count counts retries", () => {
    const attempts: ProviderAttempt[] = [
      row({
        alias: "zenmux/gpt-image-2",
        status: "error",
        error_class: "upstream_error",
        latency_ms: 30,
      }),
      row({ alias: "openai/gpt-image-2", status: "ok", cost_usd: 0.04, latency_ms: 70 }),
    ];
    const d = buildImageDecision({
      requestId: "req-internal-1",
      traceId: "t1",
      keyPrefix: "helm_live_xy",
      requested: "gpt-image", // the LANE name the client sent
      selectedLane: "gpt-image",
      candidateChain: ["zenmux/gpt-image-2", "openai/gpt-image-2"],
      attempts,
      served: { alias: "openai/gpt-image-2", providerModel: "openai/gpt-image-2" },
      finalErrorClass: null,
      usage: { input_tokens: 12, output_tokens: 200 },
    });

    expect(d.request_id).toBe("req-internal-1");
    expect(d.trace_id).toBe("t1");
    expect(d.lane.selected_lane).toBe("gpt-image");
    expect(d.lane.candidate_chain).toEqual(["zenmux/gpt-image-2", "openai/gpt-image-2"]);
    expect(d.final.model_alias).toBe("openai/gpt-image-2"); // SERVED leaf, not the lane name
    expect(d.final.status).toBe("ok");
    expect(d.fallback_count).toBe(1); // 2 non-skipped attempts → 1 fallback
    expect(d.latency_total_ms).toBe(100);
    expect(d.cost_breakdown.total_usd).toBe(0.04); // only the served attempt cost
    expect(d.provider_attempts).toHaveLength(2);
    expect(d.usage?.completion_tokens).toBe(200);
    expect(d.usage?.prompt_tokens).toBe(12);
  });

  it("a breaker-OPEN skip row does not count toward fallback_count", () => {
    const attempts: ProviderAttempt[] = [
      row({ alias: "a", skipped: true, skip_reason: "circuit_open", status: "error" }),
      row({ alias: "b", status: "ok", cost_usd: 0.01 }),
    ];
    const d = buildImageDecision({
      requestId: "req-internal-2",
      traceId: "t2",
      keyPrefix: null,
      requested: "img-lane",
      selectedLane: "img-lane",
      candidateChain: ["a", "b"],
      attempts,
      served: { alias: "b", providerModel: "wire/b" },
      finalErrorClass: null,
      usage: null,
    });
    expect(d.fallback_count).toBe(0); // skip is not an attempt
    expect(d.provider_attempts[0]?.skipped).toBe(true);
    expect(d.usage).toBeNull();
  });

  it("preserves image-token, service-tier, and billed-cost repricing evidence", () => {
    const d = buildImageDecision({
      requestId: "req-internal-rich",
      traceId: "t-rich",
      keyPrefix: null,
      requested: "gemini-3-pro-image",
      selectedLane: "image",
      candidateChain: ["google/gemini-3-pro-image"],
      attempts: [row({ alias: "google/gemini-3-pro-image", cost_usd: 0.24 })],
      served: {
        alias: "google/gemini-3-pro-image",
        providerModel: "gemini-3-pro-image",
      },
      finalErrorClass: null,
      usage: {
        input_tokens: 560,
        output_tokens: 2_000,
        service_tier: "priority",
        cost_usd: 0.24,
        output_tokens_details: { image_tokens: 2_000 },
      },
    });

    expect(d.usage).toMatchObject({
      prompt_tokens: 560,
      completion_tokens: 2_000,
      service_tier: "priority",
      image_output_tokens: 2_000,
      billed_cost_usd: 0.24,
    });
  });

  it("a fully-failed chain → error final, null cost breakdown", () => {
    const attempts: ProviderAttempt[] = [
      row({ alias: "a", status: "error", error_class: "upstream_error" }),
      row({ alias: "b", status: "error", error_class: "upstream_error" }),
    ];
    const d = buildImageDecision({
      requestId: "req-internal-3",
      traceId: "t3",
      keyPrefix: null,
      requested: "img-lane",
      selectedLane: "img-lane",
      candidateChain: ["a", "b"],
      attempts,
      served: null,
      finalErrorClass: "all_providers_failed",
      usage: null,
    });
    expect(d.final.status).toBe("error");
    expect(d.final.model_alias).toBeNull();
    expect(d.final.error_reason).toBe("all_providers_failed");
    expect(d.cost_breakdown.total_usd).toBeNull();
  });

  it("a bare single-model request keeps the legacy `image` lane label", () => {
    const attempts: ProviderAttempt[] = [
      row({ alias: "gpt-image-2", status: "ok", cost_usd: 0.006 }),
    ];
    const d = buildImageDecision({
      requestId: "req-internal-4",
      traceId: "t4",
      keyPrefix: null,
      requested: "gpt-image-2",
      selectedLane: "image",
      candidateChain: ["gpt-image-2"],
      attempts,
      served: { alias: "gpt-image-2", providerModel: "openai/gpt-image-2" },
      finalErrorClass: null,
      usage: { input_tokens: 15, output_tokens: 196 },
    });
    expect(d.lane.selected_lane).toBe("image");
    expect(d.final.model_alias).toBe("gpt-image-2");
    expect(d.fallback_count).toBe(0);
    expect(d.cost_breakdown.total_usd).toBe(0.006);
  });
});
