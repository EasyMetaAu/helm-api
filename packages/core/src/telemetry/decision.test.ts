import { DecisionRecordSchema, type InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { AttemptRecord } from "../executor/attempt-record.js";
import type { TelemetryStore } from "../store/ports.js";
import {
  buildDecisionRecord,
  type ClassifierOutput,
  type DecisionParts,
  type FinalOutcome,
  type LaneSelection,
  type PolicyOutcome,
  persistDecision,
} from "./decision.js";

// ---- fixtures ---------------------------------------------------------------

function baseRequest(overrides: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "trace_abc",
    protocol: "openai_chat",
    account_id: "acct_1",
    api_key_id: "key_1",
    user_id: null,
    org_id: null,
    requested_model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: null,
    stream: false,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
    ...overrides,
  };
}

function classifier(overrides: Partial<ClassifierOutput> = {}): ClassifierOutput {
  return {
    task_type: "coding",
    complexity: "complex",
    confidence: 0.9,
    decided_by: "rules",
    eval_cache_hit: null,
    constraints: { needs_tools: true },
    explanation: ["matched: code-block dimension"],
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyOutcome> = {}): PolicyOutcome {
  return {
    matched_policy_id: "p1",
    reason: "task=coding complexity=complex",
    ...overrides,
  };
}

function lane(overrides: Partial<LaneSelection> = {}): LaneSelection {
  return {
    selected_lane: "coding",
    candidate_chain: ["coding_model", "premium"],
    ...overrides,
  };
}

function okAttempt(alias: string): AttemptRecord {
  return {
    alias,
    skipped: false,
    skip_reason: null,
    status: "ok",
    error_class: null,
    latency_ms: 1200,
    cost_usd: 0.004,
    error_detail: null,
  };
}

function finalOk(overrides: Partial<FinalOutcome> = {}): FinalOutcome {
  return {
    status: "ok",
    model_alias: "premium",
    provider_model: "claude-x",
    error_reason: null,
    ...overrides,
  } as FinalOutcome;
}

function parts(overrides: Partial<DecisionParts> = {}): DecisionParts {
  return {
    request: baseRequest(),
    classification: classifier(),
    policy: policy(),
    lane: lane(),
    attempts: [okAttempt("premium")],
    final: finalOk(),
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------------

describe("buildDecisionRecord", () => {
  it("1. fills every field — schema parses, no undefined", () => {
    const record = buildDecisionRecord(parts());
    expect(() => DecisionRecordSchema.parse(record)).not.toThrow();

    // No undefined anywhere in the (redacted) record.
    expect(JSON.stringify(record)).not.toContain("undefined");
    for (const key of [
      "request_id",
      "trace_id",
      "requested_model",
      "classifier",
      "policy",
      "lane",
      "provider_attempts",
      "final",
    ] as const) {
      expect(record[key]).not.toBeUndefined();
    }
    expect(record.classifier.decided_by).toBe("rules");
    expect(record.policy.matched_policy_id).toBe("p1");
    expect(record.final.status).toBe("ok");
  });

  it("2. decided_by tri-state: rules / eval(bool) / default(null)", () => {
    const rules = buildDecisionRecord(parts());
    expect(rules.classifier.decided_by).toBe("rules");

    const viaEval = buildDecisionRecord(
      parts({ classification: classifier({ decided_by: "eval", eval_cache_hit: true }) }),
    );
    expect(viaEval.classifier.decided_by).toBe("eval");
    expect(typeof viaEval.classifier.eval_cache_hit).toBe("boolean");

    const fallback = buildDecisionRecord(
      parts({ classification: classifier({ decided_by: "default", eval_cache_hit: null }) }),
    );
    expect(fallback.classifier.decided_by).toBe("default");
    expect(fallback.classifier.eval_cache_hit).toBeNull();
  });

  it("3. candidate_chain is the ordered primary -> fallback chain", () => {
    const record = buildDecisionRecord(
      parts({ lane: lane({ candidate_chain: ["primary_a", "fb_b", "fb_c"] }) }),
    );
    expect(record.lane.candidate_chain).toEqual(["primary_a", "fb_b", "fb_c"]);
  });

  it("4. provider_attempts map one-to-one (skipped/error/ok)", () => {
    const attempts: AttemptRecord[] = [
      {
        alias: "a_skipped",
        skipped: true,
        skip_reason: "circuit_open",
        status: "error",
        error_class: null,
        latency_ms: 0,
        cost_usd: null,
        error_detail: null,
      },
      {
        alias: "b_error",
        skipped: false,
        skip_reason: null,
        status: "error",
        error_class: "upstream_error",
        latency_ms: 300,
        cost_usd: null,
        error_detail: null,
      },
      {
        alias: "c_ok",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 950,
        cost_usd: 0.002,
        error_detail: null,
      },
    ];
    const record = buildDecisionRecord(
      parts({
        attempts,
        lane: lane({ candidate_chain: ["a_skipped", "b_error", "c_ok"] }),
        final: finalOk({ model_alias: "c_ok", provider_model: "model-c" }),
      }),
    );
    expect(record.provider_attempts).toEqual(attempts);
    expect(record.provider_attempts[0]?.skip_reason).toBe("circuit_open");
    expect(record.provider_attempts[1]?.error_class).toBe("upstream_error");
    expect(record.provider_attempts[2]?.cost_usd).toBe(0.002);
  });

  it("4b. preserves provider metadata on each attempt", () => {
    const record = buildDecisionRecord(
      parts({
        attempts: [
          {
            ...okAttempt("anthropic/claude-opus-4-8"),
            provider_name: "anthropic",
            provider_model: "claude-opus-4-8",
            target_provider_protocol: "anthropic_messages",
          },
        ],
        final: finalOk({
          model_alias: "anthropic/claude-opus-4-8",
          provider_model: "claude-opus-4-8",
        }),
      }),
    );

    expect(record.provider_attempts[0]?.provider_name).toBe("anthropic");
    expect(record.provider_attempts[0]?.provider_model).toBe("claude-opus-4-8");
    expect(record.provider_attempts[0]?.target_provider_protocol).toBe("anthropic_messages");
  });

  it("5. terminal failure: final.status error, error_reason is an error_class", () => {
    const record = buildDecisionRecord(
      parts({
        attempts: [
          {
            alias: "a",
            skipped: false,
            skip_reason: null,
            status: "error",
            error_class: "upstream_error",
            latency_ms: 200,
            cost_usd: null,
            error_detail: {
              upstream_status: 502,
              message: "upstream returned 502",
              provider_raw: null,
            },
          },
        ],
        final: {
          status: "error",
          model_alias: null,
          provider_model: null,
          error_reason: "all_providers_failed",
        },
      }),
    );
    expect(record.final.status).toBe("error");
    expect(record.final.error_reason).toBe("all_providers_failed");
    expect(record.final.model_alias).toBeNull();
    expect(record.final.provider_model).toBeNull();
    expect(() => DecisionRecordSchema.parse(record)).not.toThrow();
  });

  it("6. redaction: plaintext key / private payload never land in the record", () => {
    const req = baseRequest({
      messages: [{ role: "user", content: "my secret diary entry — do not log" }],
    });
    // Simulate a request object that carries sensitive fields the builder must
    // never echo verbatim.
    const tainted = {
      ...req,
      authorization: "Bearer sk-live-PLAINTEXT-SECRET-123",
      api_key: "sk-live-PLAINTEXT-SECRET-123",
    } as unknown as InternalRequest;

    const record = buildDecisionRecord(parts({ request: tainted }));
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("sk-live-PLAINTEXT-SECRET-123");
    expect(serialized).not.toContain("my secret diary entry");
  });

  it("6b. redaction: a secret echoed in a per-attempt error_detail.provider_raw is fingerprinted, status/message survive", () => {
    const failed: AttemptRecord = {
      alias: "deepseek/deepseek-v4-flash",
      skipped: false,
      skip_reason: null,
      status: "error",
      error_class: "upstream_error",
      latency_ms: 306,
      cost_usd: null,
      error_detail: {
        upstream_status: 401,
        message: "upstream returned 401",
        // A pathological upstream body that echoed the caller's credential.
        provider_raw: {
          error: { message: "invalid api key" },
          authorization: "Bearer sk-live-PLAINTEXT-SECRET-123",
        },
      },
    };
    const record = buildDecisionRecord(parts({ attempts: [failed, okAttempt("deepseek")] }));
    const serialized = JSON.stringify(record);
    // The leaked key is gone; the diagnostic status + message are preserved.
    expect(serialized).not.toContain("sk-live-PLAINTEXT-SECRET-123");
    const detail = record.provider_attempts[0]?.error_detail;
    expect(detail?.upstream_status).toBe(401);
    expect(detail?.message).toBe("upstream returned 401");
    expect((detail?.provider_raw as { error?: { message?: string } })?.error?.message).toBe(
      "invalid api key",
    );
  });

  it("7. keeps the server request_id separate from client correlation trace_id", () => {
    const record = buildDecisionRecord(
      parts({
        request: baseRequest({
          request_id: "server_request_xyz",
          metadata: { ...baseRequest().metadata, trace_id: "client_trace_xyz" },
        }),
      }),
    );
    expect(record.trace_id).toBe("client_trace_xyz");
    expect(record.request_id).toBe("server_request_xyz");
  });

  it("9. latency_total_ms is the sum of every attempt's latency", () => {
    const attempts: AttemptRecord[] = [
      { ...okAttempt("a"), latency_ms: 300 },
      { ...okAttempt("b"), latency_ms: 950 },
    ];
    const record = buildDecisionRecord(parts({ attempts }));
    expect(record.latency_total_ms).toBe(1250);
  });

  it("10. fallback_count = non-skipped attempts - 1, clamped >= 0", () => {
    // one served attempt -> 0
    expect(buildDecisionRecord(parts({ attempts: [okAttempt("a")] })).fallback_count).toBe(0);
    // two served + one skipped -> skipped does NOT count -> 2 - 1 = 1
    const mixed: AttemptRecord[] = [
      { ...okAttempt("skip"), skipped: true, skip_reason: "circuit_open", latency_ms: 0 },
      { ...okAttempt("a"), status: "error", error_class: "upstream_error" },
      okAttempt("b"),
    ];
    expect(buildDecisionRecord(parts({ attempts: mixed })).fallback_count).toBe(1);
    // zero served (all skipped) -> clamp at 0
    const allSkipped: AttemptRecord[] = [
      { ...okAttempt("s1"), skipped: true, skip_reason: "circuit_open", latency_ms: 0 },
    ];
    expect(buildDecisionRecord(parts({ attempts: allSkipped })).fallback_count).toBe(0);
  });

  it("11. cost_breakdown separates eval_usd from completion_usd (eval ran)", () => {
    const attempts: AttemptRecord[] = [
      { ...okAttempt("a"), cost_usd: 0.004 },
      { ...okAttempt("b"), cost_usd: 0.001 },
    ];
    const record = buildDecisionRecord(parts({ attempts, evalUsd: 0.00002 }));
    expect(record.cost_breakdown.eval_usd).toBeCloseTo(0.00002);
    expect(record.cost_breakdown.completion_usd).toBeCloseTo(0.005);
    expect(record.cost_breakdown.total_usd).toBeCloseTo(0.00502);
  });

  it("12. completion_usd is null when no attempt carried a cost; eval_usd null when eval did not run", () => {
    const attempts: AttemptRecord[] = [{ ...okAttempt("a"), cost_usd: null }];
    const record = buildDecisionRecord(parts({ attempts }));
    expect(record.cost_breakdown.completion_usd).toBeNull();
    expect(record.cost_breakdown.eval_usd).toBeNull();
    expect(record.cost_breakdown.total_usd).toBeNull();
  });

  it("13. key_prefix is carried prefix-only (never plaintext) and defaults to null", () => {
    expect(buildDecisionRecord(parts()).key_prefix).toBeNull();
    const withPrefix = buildDecisionRecord(parts({ keyPrefix: "helm_live_ab12" }));
    expect(withPrefix.key_prefix).toBe("helm_live_ab12");
    // The prefix is NOT hashed by the redaction gate — it must survive verbatim.
    expect(JSON.stringify(withPrefix)).toContain("helm_live_ab12");
    expect(withPrefix.key_prefix).not.toMatch(/^sha256:/);
  });
});

describe("persistDecision", () => {
  function store(insert: TelemetryStore["insert"]): TelemetryStore {
    return {
      insert,
      queryRecent: async () => [],
      queryPage: async () => ({ rows: [], total: 0 }),
      getByRequestId: async () => null,
      getApiKeyId: async () => null,
      getCreatedAt: async () => null,
      queryWindow: async () => [],
      aggregate: async () => ({
        totals: {
          requests: 0,
          okCount: 0,
          errorCount: 0,
          totalCostUsd: null,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          avgLatencyMs: null,
          avgTps: null,
        },
        series: [],
        byModel: [],
      }),
      usageByKey: async () => [],
      insertPayload: async () => {},
      getPayload: async () => null,
      prunePayloads: async () => {},
      pruneTelemetry: async () => 0,
      countTelemetryOlderThan: async () => 0,
      selectTelemetryOlderThan: async () => [],
      countPayloadsOlderThan: async () => 0,
      selectPayloadsOlderThan: async () => [],
    };
  }

  it("writes the record through the TelemetryStore", async () => {
    const insert = vi.fn<TelemetryStore["insert"]>(async () => ({ id: "row_1" }));
    const record = buildDecisionRecord(parts());
    await persistDecision(store(insert), record, { apiKeyId: "key_1" });
    expect(insert).toHaveBeenCalledTimes(1);
    const arg = insert.mock.calls[0]?.[0];
    expect(arg?.decision.request_id).toBe(record.request_id);
    expect(arg?.apiKeyId).toBe("key_1");
  });

  it("8. fail-open: store.insert throwing never propagates", async () => {
    const insert = vi.fn(async () => {
      throw new Error("db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = buildDecisionRecord(parts());
    await expect(persistDecision(store(insert), record)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
