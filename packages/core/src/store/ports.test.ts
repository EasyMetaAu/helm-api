import type { ApiKeyRecord, DecisionRecord } from "@helm/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CreateKeyInput,
  InsertPayloadInput,
  InsertTelemetryInput,
  KeyPatch,
  KeyStore,
  RecentDecisionRecord,
  RequestPayload,
  RotateKeyInput,
  TelemetryAggregate,
  TelemetryKeyUsage,
  TelemetryPage,
  TelemetryPageQuery,
  TelemetryStore,
} from "./ports.js";

// A minimal in-memory KeyStore proves the KeyStore contract is implementable and
// self-consistent (if it compiles, the signatures line up). It also exercises
// the soft-revoke semantics.
class InMemoryKeyStore implements KeyStore {
  private readonly byId = new Map<string, ApiKeyRecord & { secretEnc: string | null }>();

  async createKey(input: CreateKeyInput): Promise<ApiKeyRecord> {
    const record: ApiKeyRecord & { secretEnc: string | null } = {
      key_id: input.keyId,
      hash: input.hash,
      prefix: input.prefix,
      secretEnc: input.secretEnc ?? null,
      account_id: input.accountId,
      role: input.role,
      name: input.name ?? null,
      allowed_lanes: input.allowedLanes ?? null,
      allow_custom_model: input.allowCustomModel ?? false,
      blocked_models: input.blockedModels ?? null,
      allow_fast_mode: input.allowFastMode ?? false,
      disabled: false,
      rate_limit_rpm: input.rateLimitRpm ?? null,
      rate_limit_tpm: input.rateLimitTpm ?? null,
      budget_requests: input.budgetRequests ?? null,
      budget_tokens: input.budgetTokens ?? null,
      budget_spend_usd: input.budgetSpendUsd ?? null,
      budget_window_seconds: input.budgetWindowSeconds ?? null,
      over_budget_behavior: input.overBudgetBehavior ?? "degrade",
      degrade_lane: input.degradeLane ?? null,
      concurrency_limit: input.concurrencyLimit ?? null,
      memory_mode: input.memoryMode ?? "off",
      memory_project_id: input.memoryProjectId ?? null,
      memory_thread_source: input.memoryThreadSource ?? "header",
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
  async deleteKey(keyId: string): Promise<void> {
    this.byId.delete(keyId);
  }
  async updateKey(keyId: string, patch: KeyPatch): Promise<void> {
    const r = this.byId.get(keyId);
    if (!r) return;
    const next = { ...r };
    if (patch.allowedLanes !== undefined) next.allowed_lanes = patch.allowedLanes;
    if (patch.allowCustomModel !== undefined) next.allow_custom_model = patch.allowCustomModel;
    if (patch.blockedModels !== undefined) next.blocked_models = patch.blockedModels;
    if (patch.allowFastMode !== undefined) next.allow_fast_mode = patch.allowFastMode;
    if (patch.rateLimitRpm !== undefined) next.rate_limit_rpm = patch.rateLimitRpm;
    if (patch.rateLimitTpm !== undefined) next.rate_limit_tpm = patch.rateLimitTpm;
    if (patch.budgetRequests !== undefined) next.budget_requests = patch.budgetRequests;
    if (patch.budgetTokens !== undefined) next.budget_tokens = patch.budgetTokens;
    if (patch.budgetSpendUsd !== undefined) next.budget_spend_usd = patch.budgetSpendUsd;
    if (patch.budgetWindowSeconds !== undefined)
      next.budget_window_seconds = patch.budgetWindowSeconds;
    if (patch.overBudgetBehavior !== undefined)
      next.over_budget_behavior = patch.overBudgetBehavior;
    if (patch.degradeLane !== undefined) next.degrade_lane = patch.degradeLane;
    this.byId.set(keyId, next);
  }
  async rotateKey(keyId: string, input: RotateKeyInput): Promise<void> {
    const r = this.byId.get(keyId);
    if (!r) return;
    this.byId.set(keyId, {
      ...r,
      hash: input.hash,
      prefix: input.prefix,
      secretEnc: input.secretEnc ?? null,
    });
  }
  async getSecretEnc(keyId: string): Promise<string | null> {
    return this.byId.get(keyId)?.secretEnc ?? null;
  }
}

class InMemoryTelemetryStore implements TelemetryStore {
  private readonly rows: Array<{ id: string; at: Date; rec: DecisionRecord; keyId: string }> = [];
  async insert(input: InsertTelemetryInput): Promise<{ id: string }> {
    const id = String(this.rows.length + 1);
    this.rows.push({ id, at: input.createdAt, rec: input.decision, keyId: input.apiKeyId });
    return { id };
  }
  async queryRecent(limit: number): Promise<RecentDecisionRecord[]> {
    return [...this.rows]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit)
      .map((r) => ({ record: r.rec, createdAt: r.at }));
  }
  async queryPage(query: TelemetryPageQuery): Promise<TelemetryPage> {
    const m = query.model?.toLowerCase();
    const matched = this.rows.filter(({ at, rec, keyId }) => {
      if (query.startMs !== undefined && at.getTime() < query.startMs) return false;
      if (query.endMs !== undefined && at.getTime() >= query.endMs) return false;
      if (query.apiKeyId !== undefined && keyId !== query.apiKeyId) return false;
      if (query.status !== undefined && rec.final.status !== query.status) return false;
      if (query.decidedBy !== undefined && rec.classifier.decided_by !== query.decidedBy)
        return false;
      if (query.lane !== undefined && rec.lane.selected_lane !== query.lane) return false;
      if (m !== undefined) {
        const hit =
          rec.requested_model.toLowerCase().includes(m) ||
          (rec.final.model_alias ?? "").toLowerCase().includes(m);
        if (!hit) return false;
      }
      return true;
    });
    const rows = matched
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(query.offset, query.offset + query.limit)
      .map((r) => ({ record: r.rec, createdAt: r.at, apiKeyId: r.keyId }));
    return { rows, total: matched.length };
  }
  async getByRequestId(requestId: string): Promise<DecisionRecord | null> {
    return this.rows.find((r) => r.rec.request_id === requestId)?.rec ?? null;
  }
  async getApiKeyId(requestId: string): Promise<string | null> {
    return this.rows.find((r) => r.rec.request_id === requestId)?.keyId ?? null;
  }
  async getCreatedAt(requestId: string): Promise<Date | null> {
    return this.rows.find((r) => r.rec.request_id === requestId)?.at ?? null;
  }
  async queryWindow(startMs: number, endMs: number): Promise<DecisionRecord[]> {
    return [...this.rows]
      .filter((r) => r.at.getTime() >= startMs && r.at.getTime() < endMs)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((r) => r.rec);
  }
  private readonly payloads = new Map<string, RequestPayload>();
  async insertPayload(input: InsertPayloadInput): Promise<void> {
    this.payloads.set(input.requestId, {
      ...input,
      upstreamRequestJson: input.upstreamRequestJson ?? null,
    });
  }
  async getPayload(requestId: string): Promise<RequestPayload | null> {
    return this.payloads.get(requestId) ?? null;
  }
  async prunePayloads(olderThanMs: number): Promise<void> {
    for (const [id, p] of this.payloads) {
      if (p.createdAt.getTime() < olderThanMs) this.payloads.delete(id);
    }
  }
  async pruneTelemetry(olderThanMs: number): Promise<number> {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if ((this.rows[i] as { at: Date }).at.getTime() < olderThanMs) this.rows.splice(i, 1);
    }
    return before - this.rows.length;
  }
  async countTelemetryOlderThan(olderThanMs: number): Promise<number> {
    return this.rows.filter((r) => r.at.getTime() < olderThanMs).length;
  }
  async selectTelemetryOlderThan(olderThanMs: number, limit: number, afterId?: string) {
    return this.rows
      .filter((r) => r.at.getTime() < olderThanMs && (afterId === undefined || r.id > afterId))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        requestId: r.rec.request_id,
        apiKeyId: r.keyId,
        createdAt: r.at.getTime(),
        decision: r.rec,
      }));
  }
  async countPayloadsOlderThan(olderThanMs: number): Promise<number> {
    let n = 0;
    for (const p of this.payloads.values()) if (p.createdAt.getTime() < olderThanMs) n++;
    return n;
  }
  async selectPayloadsOlderThan(olderThanMs: number, limit: number, afterId?: string) {
    return [...this.payloads.values()]
      .filter(
        (p) =>
          p.createdAt.getTime() < olderThanMs && (afterId === undefined || p.requestId > afterId),
      )
      .sort((a, b) => a.requestId.localeCompare(b.requestId))
      .slice(0, limit)
      .map((p) => ({
        id: p.requestId,
        requestId: p.requestId,
        requestJson: p.requestJson,
        responseJson: p.responseJson,
        upstreamRequestJson: p.upstreamRequestJson ?? null,
        createdAt: p.createdAt.getTime(),
      }));
  }
  // Dashboard token-accounting aggregate — a minimal in-memory roll-up over the
  // half-open window so the in-memory store satisfies the full port contract.
  async aggregate(
    startMs: number,
    endMs: number,
    bucket: "hour" | "day",
    tzOffsetMinutes = 0,
    keyId?: string,
  ): Promise<TelemetryAggregate> {
    const inWindow = this.rows.filter(
      (r) =>
        r.at.getTime() >= startMs &&
        r.at.getTime() < endMs &&
        (keyId === undefined || r.keyId === keyId),
    );
    const bucketMs = bucket === "hour" ? 3_600_000 : 86_400_000;
    const offsetMs = tzOffsetMinutes * 60_000; // local-day floor (shift-floor-unshift)
    const num = (n: number | null | undefined) => n ?? 0;
    const totals = {
      requests: inWindow.length,
      okCount: inWindow.filter((r) => r.rec.final.status === "ok").length,
      errorCount: inWindow.filter((r) => r.rec.final.status === "error").length,
      totalCostUsd: null as number | null,
      promptTokens: inWindow.reduce((s, r) => s + num(r.rec.usage?.prompt_tokens), 0),
      completionTokens: inWindow.reduce((s, r) => s + num(r.rec.usage?.completion_tokens), 0),
      cachedTokens: inWindow.reduce((s, r) => s + num(r.rec.usage?.cached_tokens), 0),
      cacheCreationTokens: inWindow.reduce(
        (s, r) => s + num(r.rec.usage?.cache_creation_tokens),
        0,
      ),
      avgLatencyMs: null as number | null,
      avgTps: null as number | null,
    };
    const seriesMap = new Map<number, TelemetryAggregate["series"][number]>();
    for (const r of inWindow) {
      const k = Math.floor((r.at.getTime() + offsetMs) / bucketMs) * bucketMs - offsetMs;
      const b = seriesMap.get(k) ?? {
        bucketStartMs: k,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        requests: 0,
        costUsd: null as number | null, // this fake punts on cost (like totalCostUsd above)
      };
      b.promptTokens += num(r.rec.usage?.prompt_tokens);
      b.completionTokens += num(r.rec.usage?.completion_tokens);
      b.cachedTokens += num(r.rec.usage?.cached_tokens);
      b.cacheCreationTokens += num(r.rec.usage?.cache_creation_tokens);
      b.requests += 1;
      seriesMap.set(k, b);
    }
    const byModelMap = new Map<string | null, TelemetryAggregate["byModel"][number]>();
    for (const r of inWindow) {
      const m = r.rec.final.provider_model ?? null;
      const b = byModelMap.get(m) ?? {
        servedModel: m,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requests: 0,
        costUsd: null as number | null, // this fake punts on cost (like totalCostUsd above)
      };
      b.promptTokens += num(r.rec.usage?.prompt_tokens);
      b.completionTokens += num(r.rec.usage?.completion_tokens);
      b.totalTokens = b.promptTokens + b.completionTokens;
      b.requests += 1;
      byModelMap.set(m, b);
    }
    return {
      totals,
      series: [...seriesMap.values()].sort((a, b) => a.bucketStartMs - b.bucketStartMs),
      byModel: [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    };
  }
  // Per-key roll-up over the half-open window, grouped by keyId (requests desc).
  async usageByKey(startMs: number, endMs: number): Promise<TelemetryKeyUsage[]> {
    const num = (n: number | null | undefined) => n ?? 0;
    const byKey = new Map<string, TelemetryKeyUsage>();
    for (const r of this.rows) {
      if (r.at.getTime() < startMs || r.at.getTime() >= endMs) continue;
      const u = byKey.get(r.keyId) ?? {
        apiKeyId: r.keyId,
        requests: 0,
        errorCount: 0,
        totalCostUsd: null as number | null,
        totalTokens: 0,
      };
      u.requests += 1;
      if (r.rec.final.status === "error") u.errorCount += 1;
      const cost = r.rec.cost_breakdown.total_usd;
      if (cost !== null) u.totalCostUsd = (u.totalCostUsd ?? 0) + cost;
      u.totalTokens += num(r.rec.usage?.prompt_tokens) + num(r.rec.usage?.completion_tokens);
      byKey.set(r.keyId, u);
    }
    return [...byKey.values()].sort(
      (a, b) => b.requests - a.requests || a.apiKeyId.localeCompare(b.apiKeyId),
    );
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
      protocol: "openai_chat",
      classifier: {
        task_type: "passthrough",
        complexity: "passthrough",
        confidence: 1,
        decided_by: "default",
        rules_confidence: null,
        eval_cache_hit: null,
        eval_model: null,
        eval_latency_ms: null,
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
      memory: null,
      usage: null,
      stream_outcome: null,
      generation_ms: null,
      serving_account: null,
    } satisfies DecisionRecord;
    await store.insert({ decision, apiKeyId: "k1", createdAt: new Date() });
    expect(await store.queryRecent(10)).toHaveLength(1);
    expect((await store.getByRequestId("req_1"))?.request_id).toBe("req_1");
    // getApiKeyId returns the INSERTED key id (not a field derived from the
    // record — the redacted record carries no key id at all), null on a miss.
    expect(await store.getApiKeyId("req_1")).toBe("k1");
    expect(await store.getApiKeyId("nope")).toBeNull();
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
      | "secretEnc"
      | "accountId"
      | "role"
      | "name"
      | "allowedLanes"
      | "allowCustomModel"
      | "blockedModels"
      | "allowFastMode"
      | "rateLimitRpm"
      | "rateLimitTpm"
      | "budgetRequests"
      | "budgetTokens"
      | "budgetSpendUsd"
      | "budgetWindowSeconds"
      | "overBudgetBehavior"
      | "degradeLane"
      | "concurrencyLimit"
      | "memoryMode"
      | "memoryProjectId"
      | "memoryThreadSource"
    >();
  });

  it("InsertTelemetryInput.decision is the shared DecisionRecord", () => {
    expectTypeOf<InsertTelemetryInput["decision"]>().toEqualTypeOf<DecisionRecord>();
  });
});
