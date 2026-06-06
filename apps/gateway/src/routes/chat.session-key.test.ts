import type {
  ApiKeyRecord,
  ExecuteOutcome,
  ExecutionResult,
  RouteOptions,
  TelemetryStore,
} from "@helm/core";
import { createMemoryMomentumStore, hashKey, scoreRequest } from "@helm/core";
import {
  type ClassifierRulesConfig,
  ClassifierRulesConfigSchema,
  type InternalRequest,
} from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ChatRouteDeps, registerChatRoutes } from "./chat.js";

// gateway.session-key — PROVE the production wiring that makes session momentum
// fire: an incoming `x-session-key` request header must be mapped into
// metadata.conversation_id on the normalized InternalRequest. The classifier's
// momentum store keys off conversation_id (engine.ts: sessionKey =
// req.metadata?.conversation_id), so without this mapping momentum NEVER fires
// in production. Closes the classifier.engine TODO (see implementation-notes).

function keyRecord(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    name: null,
    allowed_lanes: null,
    allow_custom_model: false,
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
    ...over,
  };
}

const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

function nonStreamOutcome(body: unknown): ExecuteOutcome {
  return {
    attempts: [
      {
        alias: "default_good_model",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 10,
        cost_usd: null,
        error_detail: null,
      },
    ],
    final: { status: "ok", alias: "default_good_model", providerModel: "gpt-x" },
    body,
    stream: null,
  };
}

// A route stub that captures the InternalRequest the adapter built (so we can
// assert on metadata.conversation_id) and returns a canned ok ExecutionResult.
function captureRouteDeps(): { deps: ChatRouteDeps; seen: InternalRequest[] } {
  const seen: InternalRequest[] = [];
  const deps: ChatRouteDeps = {
    route: async (req: InternalRequest, _opts: RouteOptions): Promise<ExecutionResult> => {
      seen.push(req);
      const out = nonStreamOutcome({ ok: true });
      return {
        decision: {
          lane: { selected_lane: "balanced" },
          final: { status: "ok", model_alias: "default_good_model", provider_model: "gpt-x" },
          classifier: { decided_by: "rules", eval_cache_hit: null, fallback_reason: null },
        },
        final: { status: "ok" },
        body: out.body,
        stream: null,
        error: null,
      } as unknown as ExecutionResult;
    },
    telemetry: { insert: vi.fn().mockResolvedValue({ id: "1" }) } as unknown as TelemetryStore,
    redact: (x: unknown) => x,
    now: () => 1000,
  };
  return { deps, seen };
}

function buildApp(d: ChatRouteDeps) {
  const app = createApp({ logger: { log: () => {} } });
  const getByHash = vi.fn().mockResolvedValue(keyRecord());
  app.use("/v1/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerChatRoutes(app, d);
  return app;
}

const BODY = { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false };

describe("gateway.session-key — x-session-key → metadata.conversation_id", () => {
  it("maps an incoming x-session-key header into metadata.conversation_id", async () => {
    const { deps, seen } = captureRouteDeps();
    const app = buildApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-session-key": "sess-abc" },
      body: JSON.stringify(BODY),
    });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.metadata.conversation_id).toBe("sess-abc");
  });

  it("leaves conversation_id null when no x-session-key is present", async () => {
    const { deps, seen } = captureRouteDeps();
    const app = buildApp(deps);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });

    expect(seen[0]?.metadata.conversation_id).toBeNull();
  });

  it("does not overwrite a conversation_id already present in the body metadata", async () => {
    const { deps, seen } = captureRouteDeps();
    const app = buildApp(deps);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...AUTH, "x-session-key": "from-header" },
      body: JSON.stringify({ ...BODY, metadata: { conversation_id: "from-body" } }),
    });

    expect(seen[0]?.metadata.conversation_id).toBe("from-body");
  });
});

// ── End-to-end momentum sharing across two short follow-ups ──────────────────
// Two short requests under the SAME x-session-key must share momentum state: the
// store keys off the mapped conversation_id, so the second short message leans on
// the high-complexity history seeded by the first. We drive the REAL classifier
// engine (scoreRequest) with a REAL in-memory momentum store, both fed the SAME
// conversation_id the route maps from x-session-key. Config parsed through the
// REAL schema so defaults match production (config-as-code).
function makeConfig(over: Record<string, unknown> = {}): ClassifierRulesConfig {
  return ClassifierRulesConfigSchema.parse({
    dimensions: {
      reasoning_kw: { weight: 0.35, keywords: ["prove", "derive", "theorem", "step by step"] },
      simple_kw: { weight: -0.25, keywords: ["hi", "thanks", "ok", "ping", "yes"] },
      msg_length: { weight: 0.1 },
    },
    task_keywords: { math: ["theorem", "prove"] },
    tool_prefixes: {},
    tier_boundaries: {},
    overrides: {},
    momentum: {},
    ...over,
  });
}

describe("gateway.session-key — two short follow-ups share momentum", () => {
  it("the second short message under the same x-session-key leans on history", () => {
    const cfg = makeConfig();
    const NOW = 1_700_000_000_000;
    const sessionKey = "sess-momentum"; // the value an x-session-key header maps to

    const heavyTurn: InternalRequest = {
      request_id: "r1",
      protocol: "openai_chat",
      account_id: "acct",
      api_key_id: "k1",
      user_id: null,
      org_id: null,
      requested_model: "auto",
      messages: [
        { role: "user", content: "Prove this theorem step by step and derive every lemma." },
      ],
      tools: null,
      response_format: null,
      attachments: null,
      max_tokens: null,
      stream: false,
      metadata: {
        conversation_id: sessionKey,
        thread_id: null,
        resource_id: null,
        project_id: null,
        memory_mode: "off",
      },
    };
    const shortFollowUp: InternalRequest = {
      ...heavyTurn,
      request_id: "r2",
      messages: [{ role: "user", content: "yes" }],
    };

    // Shared store: the heavy turn writes its tier back keyed by conversation_id;
    // the short follow-up under the SAME key then reads that history.
    const sharedStore = createMemoryMomentumStore();
    scoreRequest(heavyTurn, {
      cfg,
      approxTokens: 30,
      momentum: { store: sharedStore, now: () => NOW, cfg },
    });
    const withHistory = scoreRequest(shortFollowUp, {
      cfg,
      approxTokens: 1,
      momentum: { store: sharedStore, now: () => NOW + 1000, cfg },
    });

    // Control: the SAME short follow-up under a DIFFERENT session key — no shared
    // history, so momentum cannot lean on the heavy turn.
    const otherStore = createMemoryMomentumStore();
    scoreRequest(heavyTurn, {
      cfg,
      approxTokens: 30,
      momentum: { store: otherStore, now: () => NOW, cfg },
    });
    const withoutHistory = scoreRequest(
      { ...shortFollowUp, metadata: { ...heavyTurn.metadata, conversation_id: "other-key" } },
      { cfg, approxTokens: 1, momentum: { store: otherStore, now: () => NOW + 1000, cfg } },
    );

    // The short follow-up under the shared key leans on history (momentum applied)
    // and is pulled at least as high up the tier ladder as the keyless control.
    expect(withHistory.explanation.some((e) => e.source === "momentum")).toBe(true);
    const rank = { simple: 0, standard: 1, complex: 2, reasoning: 3 } as const;
    expect(rank[withHistory.complexity]).toBeGreaterThan(rank[withoutHistory.complexity]);
  });
});

export type { ExecutionResult };
