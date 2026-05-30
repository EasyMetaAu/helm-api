import { DecisionRecordSchema, type InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { AttemptRecord } from "../executor/fallback.js";
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
      },
      {
        alias: "b_error",
        skipped: false,
        skip_reason: null,
        status: "error",
        error_class: "upstream_error",
        latency_ms: 300,
        cost_usd: null,
      },
      {
        alias: "c_ok",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 950,
        cost_usd: 0.002,
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

  it("7. trace_id is threaded from the request context", () => {
    const record = buildDecisionRecord(
      parts({ request: baseRequest({ request_id: "trace_xyz" }) }),
    );
    expect(record.trace_id).toBe("trace_xyz");
    expect(record.request_id).toBe("trace_xyz");
  });
});

describe("persistDecision", () => {
  function store(insert: TelemetryStore["insert"]): TelemetryStore {
    return {
      insert,
      queryRecent: async () => [],
      getByRequestId: async () => null,
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
