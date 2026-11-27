import { UpstreamError } from "@helm/core";
import { describe, expect, it } from "vitest";
import {
  createSSEErrorObserver,
  createStreamErrorObserver,
  markStartedStreamError,
} from "./request-cancellation.js";
import { buildImageDecision } from "./routes/image-telemetry.js";
import { backfillCompletionCost } from "./routes/payload-capture.js";

function decision() {
  return buildImageDecision({
    requestId: "r",
    traceId: "t",
    keyPrefix: null,
    requested: "model",
    selectedLane: "lane",
    candidateChain: ["p/model"],
    attempts: [
      {
        alias: "p/model",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 1,
        cost_usd: null,
        error_detail: null,
      },
    ],
    served: { alias: "p/model", providerModel: "model" },
    finalErrorClass: null,
    usage: null,
  });
}
describe("started stream error diagnostics", () => {
  it.each([
    "openai_chat",
    "anthropic_messages",
    "gemini",
  ] as const)("records split %s errors without retaining unrelated response snapshots", (protocol) => {
    const d = decision();
    const observe = createSSEErrorObserver(protocol, (error) =>
      markStartedStreamError(d, "upstream_error", error),
    );
    const error = {
      message: "quota exhausted",
      code: "limit",
      request_id: "up-123",
      token: "private",
    };
    const wire = `event: error\r\ndata: ${JSON.stringify({ type: "error", error, response: { instructions: "private input" } })}\r\n\r\n`;
    observe(wire.slice(0, 25));
    observe(wire.slice(25));
    expect(d.final).toMatchObject({
      status: "error",
      error_detail: {
        provider_raw: {
          error: { message: "quota exhausted", request_id: "up-123", token: "[redacted]" },
        },
      },
    });
    expect(d.provider_attempts[0]?.error_detail).toEqual(d.final.error_detail);
    expect(d.provider_attempts[0]?.status).toBe("ok");
    expect(JSON.stringify(d)).not.toContain("private input");
  });
  it("records thrown failures after output", () => {
    const d = decision();
    markStartedStreamError(
      d,
      "upstream_error",
      new UpstreamError("upstream_error", "failed", { error: { message: "actual detail" } }, 503),
    );
    expect(d.final.error_detail).toMatchObject({
      upstream_status: 503,
      provider_raw: { error: { message: "actual detail" } },
    });
  });
});

it("retains incurred cost and usage when a committed stream ends in an upstream error", () => {
  const d = decision();
  markStartedStreamError(
    d,
    "upstream_error",
    new UpstreamError("upstream_error", "failed", { error: { message: "capacity exhausted" } }),
  );
  backfillCompletionCost(d, d.final.model_alias, 0.02, { prompt_tokens: 12, completion_tokens: 4 });
  expect(d.final.status).toBe("error");
  expect(d.provider_attempts[0]).toMatchObject({ status: "ok", cost_usd: 0.02 });
  expect(d.cost_breakdown.total_usd).toBe(0.02);
  expect(d.usage?.completion_tokens).toBe(4);
});
