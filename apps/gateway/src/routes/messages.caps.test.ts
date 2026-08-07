import type { ApiKeyRecord } from "@helm/core";
import { hashKey } from "@helm/core";
import { describe, expect, it } from "vitest";
import { capsFromRecord } from "./messages.js";

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    name: null,
    allowed_lanes: ["economy", "balanced"],
    allow_custom_model: false,
    blocked_models: null,
    allow_fast_mode: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    budget_requests: null,
    budget_tokens: null,
    budget_spend_usd: null,
    budget_window_seconds: null,
    over_budget_behavior: "degrade",
    degrade_lane: null,
    concurrency_limit: null,
    memory_mode: "off" as const,
    memory_project_id: null,
    memory_thread_source: "header" as const,
    request_content_mode: null,
    max_reasoning_effort: null,
    ...overrides,
  };
}

// Regression: the self-auth /v1/chat + /v1/messages + /v1/responses faces build
// MessagesIdentity.caps from the ApiKeyRecord. `maxReasoningEffort` was added to
// the DB column + the clamp (clampClientReasoningEffortToKeyMax) but NOT to these
// caps builders, so the per-key ceiling silently no-op'd on every route (the clamp
// received `undefined`). This pins the mapping so a future cap can't drift the same
// way — capsFromRecord is now the single source of truth for all three faces.
describe("capsFromRecord", () => {
  it("carries max_reasoning_effort into caps.maxReasoningEffort (the dropped ceiling)", () => {
    expect(capsFromRecord(record({ max_reasoning_effort: "medium" })).maxReasoningEffort).toBe(
      "medium",
    );
  });

  it("carries a null ceiling through as null (no cap)", () => {
    expect(capsFromRecord(record({ max_reasoning_effort: null })).maxReasoningEffort).toBeNull();
  });

  it("maps the rest of the record's cost/limit caps too", () => {
    const caps = capsFromRecord(
      record({
        allowed_lanes: ["balanced"],
        allow_custom_model: true,
        blocked_models: ["openai/*"],
        allow_fast_mode: true,
        rate_limit_rpm: 10,
        rate_limit_tpm: 1000,
        concurrency_limit: 3,
        request_content_mode: "payload",
      }),
    );
    expect(caps).toMatchObject({
      allowedLanes: ["balanced"],
      allowCustomModel: true,
      blockedModels: ["openai/*"],
      allowFastMode: true,
      rateLimit: { rpm: 10, tpm: 1000 },
      concurrencyLimit: 3,
      requestContentMode: "payload",
    });
  });
});
