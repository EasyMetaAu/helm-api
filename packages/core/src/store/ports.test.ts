import type { ApiKeyRecord, DecisionRecord } from "@helm/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CreateKeyInput,
  InsertPayloadInput,
  InsertTelemetryInput,
  KeyStore,
  RecentDecisionRecord,
  RequestPayload,
  TelemetryStore,
} from "./ports.js";

// A minimal in-memory KeyStore proves the KeyStore contract is implementable and
// self-consistent (if it compiles, the signatures line up). It also exercises
// the soft-revoke semantics.
class InMemoryKeyStore implements KeyStore {
  private readonly byId = new Map<string, ApiKeyRecord>();

  async createKey(input: CreateKeyInput): Promise<ApiKeyRecord> {
    const record: ApiKeyRecord = {
      key_id: input.keyId,
      hash: input.hash,
      prefix: input.prefix,
      account_id: input.accountId,
      role: input.role,
      max_lane: input.maxLane ?? null,
      allowed_lanes: input.allowedLanes ?? null,
      allow_custom_model: input.allowCustomModel ?? false,
      disabled: false,
      rate_limit_rpm: input.rateLimitRpm ?? null,
      rate_limit_tpm: input.rateLimitTpm ?? null,
    };
    this.byId.set(record.key_id, record);
    return record;
  }
  async getByHash(hash: string): Promise<ApiKeyRecord | null> {
    for (const r of this.byId.values()) {
      if (r.hash === hash) return r;
    }
    return null;
  }
  async list(): Promise<ApiKeyRecord[]> {
    return [...this.byId.values()];
  }
  async disable(keyId: string): Promise<void> {
    const r = this.byId.get(keyId);
    if (r) this.byId.set(keyId, { ...r, disabled: true });
  }
  async updateRateLimit(keyId: string, rpm: number | null, tpm: number | null): Promise<void> {
    const r = this.byId.get(keyId);
    if (r) this.byId.set(keyId, { ...r, rate_limit_rpm: rpm, rate_limit_tpm: tpm });
  }
}

class InMemoryTelemetryStore implements TelemetryStore {
  private readonly rows: Array<{ at: Date; rec: DecisionRecord }> = [];
  async insert(input: InsertTelemetryInput): Promise<{ id: string }> {
    this.rows.push({ at: input.createdAt, rec: input.decision });
    return { id: String(this.rows.length) };
  }
  async queryRecent(limit: number): Promise<RecentDecisionRecord[]> {
    return [...this.rows]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit)
      .map((r) => ({ record: r.rec, createdAt: r.at }));
  }
  async getByRequestId(requestId: string): Promise<DecisionRecord | null> {
    return this.rows.find((r) => r.rec.request_id === requestId)?.rec ?? null;
  }
  async queryWindow(startMs: number, endMs: number): Promise<DecisionRecord[]> {
    return [...this.rows]
      .filter((r) => r.at.getTime() >= startMs && r.at.getTime() < endMs)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((r) => r.rec);
  }
  private readonly payloads = new Map<string, RequestPayload>();
  async insertPayload(input: InsertPayloadInput): Promise<void> {
    this.payloads.set(input.requestId, { ...input });
  }
  async getPayload(requestId: string): Promise<RequestPayload | null> {
    return this.payloads.get(requestId) ?? null;
  }
  async prunePayloads(olderThanMs: number): Promise<void> {
    for (const [id, p] of this.payloads) {
      if (p.createdAt.getTime() < olderThanMs) this.payloads.delete(id);
    }
  }
}

describe("Store ports are implementable contracts", () => {
  it("InMemoryKeyStore satisfies KeyStore including soft revoke", async () => {
    const store = new InMemoryKeyStore();
    await store.createKey({
      keyId: "k1",
      hash: "h1",
      prefix: "helm_live_ab",
      accountId: "acct",
      role: "root",
    });
    expect((await store.getByHash("h1"))?.disabled).toBe(false);
    await store.disable("k1");
    const revoked = await store.getByHash("h1");
    expect(revoked).not.toBeNull(); // disabled keys are still returned
    expect(revoked?.disabled).toBe(true);
    expect(await store.list()).toHaveLength(1); // never physically deleted
  });

  it("InMemoryTelemetryStore satisfies TelemetryStore", async () => {
    const store = new InMemoryTelemetryStore();
    const decision = {
      request_id: "req_1",
      trace_id: "req_1",
      requested_model: "m",
      classifier: {
        task_type: "passthrough",
        complexity: "passthrough",
        confidence: 1,
        decided_by: "default",
        eval_cache_hit: null,
        constraints: {},
        explanation: [],
      },
      policy: { matched_policy_id: null, reason: "passthrough" },
      lane: { selected_lane: "passthrough", candidate_chain: ["m"] },
      provider_attempts: [],
      final: { model_alias: "m", provider_model: "m", status: "ok", error_reason: null },
      key_prefix: null,
      latency_total_ms: 0,
      fallback_count: 0,
      cost_breakdown: { eval_usd: null, completion_usd: null, total_usd: null },
    } satisfies DecisionRecord;
    await store.insert({ decision, apiKeyId: "k1", createdAt: new Date() });
    expect(await store.queryRecent(10)).toHaveLength(1);
    expect((await store.getByRequestId("req_1"))?.request_id).toBe("req_1");
  });
});

describe("port type contracts", () => {
  it("CreateKeyInput carries no plaintext credential field", () => {
    type Keys = keyof CreateKeyInput;
    expectTypeOf<Keys>().not.toEqualTypeOf<"plaintext">();
    // exhaustive key set — adding a plaintext field would break this
    expectTypeOf<Keys>().toEqualTypeOf<
      | "keyId"
      | "hash"
      | "prefix"
      | "accountId"
      | "role"
      | "maxLane"
      | "allowedLanes"
      | "allowCustomModel"
      | "rateLimitRpm"
      | "rateLimitTpm"
    >();
  });

  it("InsertTelemetryInput.decision is the shared DecisionRecord", () => {
    expectTypeOf<InsertTelemetryInput["decision"]>().toEqualTypeOf<DecisionRecord>();
  });
});
