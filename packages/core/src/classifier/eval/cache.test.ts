import type { EvalConfig, EvalOutput, InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createEvalCache, runEvalCached } from "./cache.js";
import type { ClassifierInput } from "./cache-key.js";
import type { EvalClientDeps, EvalDecision, EvalModelRequest } from "./client.js";

// eval.cache — TTL + LRU container plus the `runEvalCached` wrapper. The wrapper
// hits the cache on a content-hash key; only `decided:true` results are written
// (fail-open shakes must NOT be cached, or one transient failure gets pinned).
// Time is injected (nowMs) so TTL expiry is deterministic; the container never
// calls Date.now() itself.

const OUTPUT: EvalOutput = { complexity: "complex", task_type: "coding", confidence: 0.9 };

function makeInput(over: Partial<ClassifierInput> = {}): ClassifierInput {
  const base = {
    request_id: "req-1",
    protocol: "openai_chat",
    account_id: "acct-1",
    api_key_id: "key-1",
    user_id: null,
    org_id: null,
    requested_model: "gpt-4o",
    messages: [{ role: "user", content: "hello world" }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: 256,
    stream: false,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
  } satisfies InternalRequest;
  return { ...base, ...over } as ClassifierInput;
}

function makeConfig(over: Partial<EvalConfig> = {}): EvalConfig {
  return {
    enabled: true,
    model: "deepseek/deepseek-v4-flash",
    temperature: 0,
    max_tokens: 256,
    timeout_ms: 300,
    outer_timeout_ms: 250,
    on_failure: "balanced",
    cache: { enabled: true, key: "content_hash", ttl_sec: 300, max_entries: 5000 },
    ...over,
  };
}

// Deps for runEvalCached: real EvalClientDeps<ClassifierInput> wiring whose
// invokeModel returns a canned successful eval JSON, plus a controllable clock.
function makeDeps(
  decision: EvalDecision = { decided: true, output: OUTPUT, latency_ms: 5, cost_usd: null },
) {
  let nowMs = 1_000;
  const invokeModel = vi.fn();
  const deps: EvalClientDeps<ClassifierInput> = {
    config: makeConfig(),
    invokeModel,
    buildPrompt: (): EvalModelRequest["messages"] => [{ role: "user", content: "classify" }],
    now: () => nowMs,
    log: () => {},
  };
  // runEval is injected so the test controls the decision deterministically.
  const runEval = vi.fn(async (): Promise<EvalDecision> => decision);
  return {
    deps,
    runEval,
    setNow: (v: number) => {
      nowMs = v;
    },
    getNow: () => nowMs,
  };
}

describe("createEvalCache — TTL + LRU container", () => {
  it("returns a hit only while unexpired, then evicts on TTL", () => {
    const cache = createEvalCache({ ttlSec: 300, maxEntries: 10 });
    cache.set("k1", OUTPUT, 1_000);
    expect(cache.get("k1", 1_000)).toEqual(OUTPUT);
    // 299s later → still alive.
    expect(cache.get("k1", 1_000 + 299_000)).toEqual(OUTPUT);
    // 300s later → expired → miss, and the entry is dropped.
    expect(cache.get("k1", 1_000 + 300_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least-recently-used entry past maxEntries", () => {
    const cache = createEvalCache({ ttlSec: 300, maxEntries: 2 });
    cache.set("a", OUTPUT, 1_000);
    cache.set("b", OUTPUT, 1_000);
    // Touch "a" so "b" becomes the LRU victim.
    expect(cache.get("a", 1_000)).toEqual(OUTPUT);
    cache.set("c", OUTPUT, 1_000); // over capacity → evict "b"
    expect(cache.size).toBe(2);
    expect(cache.get("a", 1_000)).toEqual(OUTPUT);
    expect(cache.get("c", 1_000)).toEqual(OUTPUT);
    expect(cache.get("b", 1_000)).toBeUndefined();
  });
});

describe("runEvalCached", () => {
  it("calls runEval once on a miss, then serves the second identical request from cache", async () => {
    const cache = createEvalCache({ ttlSec: 300, maxEntries: 10 });
    const { deps, runEval, getNow } = makeDeps();
    const input = makeInput();

    const first = await runEvalCached(input, { ...deps, cache, runEval, nowMs: getNow() });
    expect(first.cache_hit).toBe(false);
    expect(first).toMatchObject({ decided: true, output: OUTPUT });
    expect(runEval).toHaveBeenCalledTimes(1);

    const second = await runEvalCached(makeInput(), { ...deps, cache, runEval, nowMs: getNow() });
    expect(second.cache_hit).toBe(true);
    expect(second).toMatchObject({ decided: true, output: OUTPUT });
    // No second underlying eval.
    expect(runEval).toHaveBeenCalledTimes(1);
  });

  it("bypasses existing entries and storage when cache.enabled is false", async () => {
    const cache = createEvalCache({ ttlSec: 300, maxEntries: 10 });
    cache.set("unrelated", OUTPUT, 1_000);
    const { deps, runEval, getNow } = makeDeps();
    deps.config = makeConfig({ cache: { ...deps.config.cache, enabled: false } });
    const input = makeInput();

    const first = await runEvalCached(input, { ...deps, cache, runEval, nowMs: getNow() });
    const second = await runEvalCached(input, { ...deps, cache, runEval, nowMs: getNow() });

    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(false);
    expect(runEval).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
  });

  it("re-evaluates after the TTL window elapses", async () => {
    const cache = createEvalCache({ ttlSec: 300, maxEntries: 10 });
    const { deps, runEval } = makeDeps();
    const input = makeInput();

    await runEvalCached(input, { ...deps, cache, runEval, nowMs: 1_000 });
    expect(runEval).toHaveBeenCalledTimes(1);

    // 300s later → expired → re-evaluate.
    const again = await runEvalCached(input, { ...deps, cache, runEval, nowMs: 1_000 + 300_000 });
    expect(again.cache_hit).toBe(false);
    expect(runEval).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache fail-open (decided:false) results", async () => {
    const cache = createEvalCache({ ttlSec: 300, maxEntries: 10 });
    const { deps, runEval } = makeDeps({ decided: false, reason: "timeout", latency_ms: 7 });
    const input = makeInput();

    const first = await runEvalCached(input, { ...deps, cache, runEval, nowMs: 1_000 });
    expect(first).toMatchObject({ decided: false, reason: "timeout", cache_hit: false });
    expect(cache.size).toBe(0);

    // Next identical request must re-run eval (no pinned failure).
    const second = await runEvalCached(input, { ...deps, cache, runEval, nowMs: 1_000 });
    expect(second.cache_hit).toBe(false);
    expect(runEval).toHaveBeenCalledTimes(2);
  });
});
