import { createMemoryMomentumStore } from "@helm/core";
import { ClassifierConfigSchema, type InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { buildClassifyAdapter, type ProviderForEval } from "./classify.js";

// momentum-wire — PROVE the production classify path reads/writes session
// momentum end-to-end. The composition root (server.ts buildServer) instantiates
// ONE in-memory momentum store and injects it into the classify adapter's deps;
// the adapter then passes it as `scoreRequest(..., { momentum })`. This closes
// the gateway.session-key residual: previously the adapter never built a momentum
// store and `scoreRequest` ran with `momentum` undefined, so Layer-1 momentum
// (engine.ts) was dead in production even though sessionKey now flows from
// metadata.conversation_id (mapped from x-session-key).
//
// We drive the REAL adapter (the seam server.ts wires) with a REAL in-memory
// store, config parsed through the REAL schema (defaults match production:
// 30-min TTL + last-5 window). Two short follow-ups under the SAME
// conversation_id share momentum; a follow-up with NO session key is unaffected.

const LANES = {
  economy: { primary: "cheap_model", fallback: ["balanced"], constraints: {} },
  balanced: { primary: "default_good_model", fallback: ["premium"], constraints: {} },
  premium: { primary: "best_reasoning_model", fallback: ["balanced"], constraints: {} },
} as never;

// A classifier config with momentum ENABLED and dimension keywords that make the
// rank order observable: a "prove/derive/theorem" turn scores high, a bare "yes"
// scores low — momentum should pull the short follow-up back up toward history.
function classifierWithMomentum() {
  return ClassifierConfigSchema.parse({
    rules: {
      dimensions: {
        reasoning_kw: { weight: 0.35, keywords: ["prove", "derive", "theorem", "step by step"] },
        simple_kw: { weight: -0.25, keywords: ["hi", "thanks", "ok", "ping", "yes"] },
        msg_length: { weight: 0.1 },
      },
      task_keywords: { math: ["theorem", "prove"] },
      tool_prefixes: {},
      tier_boundaries: {},
      overrides: {},
      momentum: {}, // schema defaults: enabled, ttl_sec 1800, history_size 5, max_history_weight 0.6
    },
    eval: { model: "eval-model" }, // eval stays OFF (default) — pure Layer-1 path
  });
}

// Eval provider that must NEVER be called on this Layer-1-only path; if it is,
// the test surfaces it (the verdict would override the rules result).
function neverEvalProvider(): ProviderForEval {
  return {
    chatCompletion: async () => {
      throw new Error("eval must not be invoked on the Layer-1 momentum path");
    },
  };
}

function req(text: string, conversationId: string | null): InternalRequest {
  return {
    messages: [{ role: "user", content: text }],
    tools: null,
    response_format: null,
    attachments: null,
    metadata: { conversation_id: conversationId },
  } as unknown as InternalRequest;
}

const rank = { simple: 0, medium: 1, complex: 2 } as const;

describe("classify adapter — session momentum wiring (deps.momentum)", () => {
  it("two short follow-ups under the same conversation_id lean on momentum history", async () => {
    const cfg = classifierWithMomentum();
    // ONE store, shared across requests (the singleton server.ts creates).
    const store = createMemoryMomentumStore();
    let nowMs = 1_700_000_000_000;

    const classify = buildClassifyAdapter({
      getClassifierConfig: () => cfg,
      lanes: LANES,
      provider: neverEvalProvider(),
      now: () => nowMs,
      log: () => {},
      momentum: { store },
    });

    const SESSION = "sess-momentum";
    // Heavy reasoning turn under the session — writes its tier back into history.
    await classify(req("Prove this theorem step by step and derive every lemma.", SESSION));
    nowMs += 1000;
    // Short follow-up under the SAME session — momentum pulls it up.
    const withHistory = await classify(req("yes", SESSION));

    // Control: the SAME short follow-up under NO session key — momentum cannot
    // fire (fail-open: no session key -> no momentum), so it stays low.
    const keylessStore = createMemoryMomentumStore();
    const classifyKeyless = buildClassifyAdapter({
      getClassifierConfig: () => cfg,
      lanes: LANES,
      provider: neverEvalProvider(),
      now: () => nowMs,
      log: () => {},
      momentum: { store: keylessStore },
    });
    const withoutHistory = await classifyKeyless(req("yes", null));

    // The shared-session follow-up is pulled at least as high up the ladder as the
    // keyless control, and strictly higher than it would be with no history.
    expect(rank[withHistory.complexity]).toBeGreaterThan(rank[withoutHistory.complexity]);
  });

  it("is fail-open without a momentum store (adapter still classifies, no momentum)", async () => {
    const cfg = classifierWithMomentum();
    const classify = buildClassifyAdapter({
      getClassifierConfig: () => cfg,
      lanes: LANES,
      provider: neverEvalProvider(),
      now: () => 1_700_000_000_000,
      log: () => {},
      // no momentum dep at all
    });

    // No store -> heavy history can't carry over; the short follow-up classifies
    // on its own merits (low), never throwing.
    await classify(req("Prove this theorem step by step and derive every lemma.", "s1"));
    const followUp = await classify(req("yes", "s1"));
    expect(followUp.complexity).toBe("simple");
  });
});
