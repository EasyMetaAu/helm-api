import { describe, expect, it } from "vitest";
import type { PortalRequestDetail } from "./api/portal";
import { normalizePortalDetail } from "./request-detail-normalize";

const base: PortalRequestDetail = {
  request_id: "r1",
  trace_id: "r1",
  requested_model: "auto",
  served_model: "gpt-5",
  lane: "balanced",
  status: "ok",
  error_reason: null,
  latency_ms: 100,
  cost_usd: 0.01,
  usage: null,
  requested_reasoning_effort: null,
  reasoning_effort: null,
  generation_ms: null,
  tps: null,
  ttfb_ms: null,
  attempts: [],
};

describe("normalizePortalDetail", () => {
  it("passes a fully-populated detail through unchanged", () => {
    const full: PortalRequestDetail = {
      ...base,
      attempts: [{ outcome: "success", latency_ms: 5 }],
      tps: 12,
      ttfb_ms: 50,
      generation_ms: 200,
    };
    expect(normalizePortalDetail(full)).toEqual(full);
  });

  it("defaults fields an older gateway omits (undefined, not null, after JSON.parse)", () => {
    const legacy = { ...base } as Record<string, unknown>;
    delete legacy.attempts;
    delete legacy.tps;
    delete legacy.ttfb_ms;
    delete legacy.generation_ms;

    expect(
      normalizePortalDetail(legacy as unknown as PortalRequestDetail),
    ).toEqual(base);
  });
});
