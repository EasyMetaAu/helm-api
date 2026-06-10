import { fileURLToPath } from "node:url";
import type {
  CircuitBreaker,
  ExecutionPlan,
  LanesConfig,
  ProviderClient,
  ProviderRegistry,
} from "@helm/core";
import {
  createCircuitBreaker,
  createProviderRegistry,
  DEFAULT_LANES,
  loadConfig,
  loadRuntimeCatalog,
  parseLanesConfig,
  toRegistryProviders,
} from "@helm/core";
import type { CatalogEntry, InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createExecute } from "./execute.js";

// execute.default-config — PROVES the capability filter + cost path FIRE on the
// SHIPPED default config (config/*.yaml + the checked-in generated catalog).
// The lane candidate ALIAS is the catalog/pricing modelKey AND the breaker key;
// the resolved `provider_model` (a possibly-different bare upstream id, see
// fix-upstream-model-id 2026-05-31) is only sent on the wire. The generated
// catalog is keyed by the alias, so a lookup by the candidate alias resolves and:
//   • a json-incapable `*/auto` candidate is PRUNED with a skip_reason and the
//     chain lands on a json-capable model;
//   • a chain of ONLY json-incapable candidates → capability_unsatisfiable;
//   • a served attempt records a non-null cost_usd from the aligned pricing.
//
// This is an INTEGRATION test over the real loaders (loadConfig + loadRuntime
// Catalog + the same registry wiring server.ts builds), driving the production
// `createExecute` with a stub upstream — so the assertions reflect the bytes a
// deployment actually ships, not synthetic fixtures.

const CONFIG_DIR = fileURLToPath(new URL("../../../../config", import.meta.url));

// Load the shipped catalog + lanes + providers exactly as buildServer does.
const catalog: Map<string, CatalogEntry> = loadRuntimeCatalog({ configDir: CONFIG_DIR });
// env:{} so no env override; we only need providers[] + lanes shape, not creds.
const config = loadConfig({ configDir: CONFIG_DIR, env: {} });
const lanes: LanesConfig = config.lanes ?? parseLanesConfig(DEFAULT_LANES);

// Mirror server.ts buildRegistry: explicit per-model providers + back-fill of
// any remaining lane alias against the primary (provider_model === alias). With
// the aligned config every lane candidate is an explicit alias, so back-fill is
// effectively empty — but we keep the logic so the test tracks production.
function buildRegistry(): ProviderRegistry {
  const explicit = toRegistryProviders(
    config.providers.filter((p) => p.models.length > 0),
    { fallbackBaseUrl: "http://mock" },
  );
  const mapped = new Set<string>();
  for (const p of explicit) for (const m of p.models) mapped.add(m.alias);
  const backfill = new Set<string>();
  for (const [, lane] of Object.entries(lanes)) {
    for (const el of [lane.primary, ...lane.fallback]) {
      if (!Object.hasOwn(lanes, el) && !mapped.has(el)) backfill.add(el);
    }
  }
  const cfgs = [...explicit];
  const first = config.providers[0];
  if (first && backfill.size > 0) {
    cfgs.push({
      name: first.name,
      base_url: first.base_url ?? "http://mock",
      api_key_env: first.api_key_env,
      models: [...backfill].map((alias) => ({ alias, provider_model: alias })),
    });
  }
  return createProviderRegistry(cfgs);
}

// Chain expansion identical to route-request.expandChain (recursive, deduped,
// cycle-safe) so the test exercises the real shipped lane chains.
function expandChain(laneName: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (alias: string) => {
    if (!seen.has(alias)) {
      seen.add(alias);
      chain.push(alias);
    }
  };
  const visit = (name: string, visited: Set<string>) => {
    if (visited.has(name)) return;
    visited.add(name);
    const lane = lanes[name];
    if (lane === undefined) {
      push(name);
      return;
    }
    for (const el of [lane.primary, ...lane.fallback]) {
      if (Object.hasOwn(lanes, el)) visit(el, visited);
      else push(el);
    }
  };
  visit(laneName, new Set<string>());
  return chain;
}

function req(over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-default-config",
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
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
    ...over,
  };
}

function plan(chain: string[]): ExecutionPlan {
  return { selected_lane: "json", candidate_chain: chain, explicit_model: null };
}

function breaker(): CircuitBreaker {
  return createCircuitBreaker({ config: { failureThreshold: 5, cooldownMs: 1000 }, now: () => 0 });
}

function clock() {
  let t = 0;
  return () => (t += 10);
}

// A stub upstream that echoes a fixed usage so cost can be derived from the
// aligned pricing catalog. Records which provider_model it was asked to run.
function stubProvider(): { client: ProviderClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    chatCompletion: vi.fn(async (body: Record<string, unknown>) => {
      calls.push(String(body.model));
      return {
        id: "chatcmpl-stub",
        object: "chat.completion",
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      };
    }),
    chatCompletionStream: vi.fn(),
  } as unknown as ProviderClient;
  return { client, calls };
}

function providerClients(client: ProviderClient): Map<string, ProviderClient> {
  return new Map(config.providers.map((p) => [p.name, client]));
}

describe("default config activates capability filter + cost (alias-namespace alignment)", () => {
  it("sanity: the shipped catalog is keyed by the SAME provider/model aliases the lanes use", () => {
    // Pre-alignment these were absent (lane aliases like `cheap_model` had no
    // catalog entry). Now every lane candidate alias resolves in the catalog.
    expect(catalog.get("deepseek/deepseek-v4-flash")?.capabilities.supportsJsonMode).toBe(true);
    expect(catalog.get("zenmux/auto")?.capabilities.supportsJsonMode).toBe(false);
    expect(catalog.get("openrouter/auto")?.capabilities.supportsJsonMode).toBe(false);
    expect(catalog.get("zenmux/gemini-3.5-flash")?.capabilities.supportsCachedContent).toBe(true);
    // pricing is populated (so cost can be computed, not null).
    expect(catalog.get("deepseek/deepseek-v4-flash")?.pricing.inputPerMTokUsd).toBeGreaterThan(0);
  });

  it("PRUNES a json-incapable */auto candidate and lands on a json-capable model (skip_reason recorded)", async () => {
    const { client, calls } = stubProvider();
    const registry = buildRegistry();
    const execute = createExecute({
      defaultProvider: client,
      providers: providerClients(client),
      registry,
      breaker: breaker(),
      catalog,
      now: clock(),
      signal: new AbortController().signal,
    });

    // A chain that puts the json-INCAPABLE auto FIRST, then a json-capable model.
    // A needs_json request must SKIP the auto (skip_reason no_json_support) and
    // land on the capable model — proving the filter prunes on the real catalog.
    // The landing model is deepseek/deepseek-v4-pro (json-capable).
    const chain = ["zenmux/auto", "deepseek/deepseek-v4-pro"];
    const out = await execute(plan(chain), req({ response_format: { type: "json_object" } }));

    expect(out.attempts[0]?.alias).toBe("zenmux/auto");
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("no_json_support");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("deepseek/deepseek-v4-pro");
    // The pruned auto must NEVER have been invoked upstream. The upstream `model`
    // is the RESOLVED bare provider_model (`deepseek-v4-pro`), not the alias.
    expect(calls).toEqual(["deepseek-v4-pro"]);
  });

  it("the shipped `json` lane serves its json-capable primary and never reaches the */auto tail", async () => {
    const { client, calls } = stubProvider();
    const execute = createExecute({
      defaultProvider: client,
      providers: providerClients(client),
      registry: buildRegistry(),
      breaker: breaker(),
      catalog,
      now: clock(),
      signal: new AbortController().signal,
    });
    // Expand the REAL shipped `json` lane: primary deepseek/deepseek-v4-flash, then
    // balanced (whose tail is zenmux/auto + openrouter/auto, both json-incapable).
    const chain = expandChain("json");
    expect(chain).toContain("deepseek/deepseek-v4-flash");
    expect(chain).toContain("zenmux/auto");
    expect(chain).toContain("openrouter/auto");
    const out = await execute(plan(chain), req({ response_format: { type: "json_object" } }));
    expect(out.final.status).toBe("ok");
    // The json primary deepseek/deepseek-v4-flash is json-capable AND serves
    // non-stream requests, so it lands FIRST — the json-incapable */auto tails
    // (which WOULD be pruned, proven head-on by the previous test) are never
    // reached. The upstream `model` is the bare provider_model.
    if (out.final.status === "ok") expect(out.final.alias).toBe("deepseek/deepseek-v4-flash");
    expect(calls).toEqual(["deepseek-v4-flash"]);
  });

  it("a chain of ONLY json-incapable candidates → capability_unsatisfiable (422 class)", async () => {
    const { client, calls } = stubProvider();
    const execute = createExecute({
      defaultProvider: client,
      providers: providerClients(client),
      registry: buildRegistry(),
      breaker: breaker(),
      catalog,
      now: clock(),
      signal: new AbortController().signal,
    });
    // Both candidates are the real json-INCAPABLE auto aliases. A needs_json
    // request can satisfy NEITHER → no candidate is ever attempted → the
    // structured terminal error is capability_unsatisfiable (maps to 422),
    // distinct from all_providers_failed (502) / lane_unavailable (503).
    const chain = ["zenmux/auto", "openrouter/auto"];
    const out = await execute(plan(chain), req({ response_format: { type: "json_object" } }));
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("capability_unsatisfiable");
    }
    expect(out.attempts.every((a) => a.skipped)).toBe(true);
    expect(out.attempts.map((a) => a.skip_reason)).toEqual(["no_json_support", "no_json_support"]);
    // Nothing was invoked upstream.
    expect(calls).toEqual([]);
  });

  it("COMPUTES a non-null cost_usd from the aligned pricing catalog on a served attempt", async () => {
    const { client } = stubProvider();
    const execute = createExecute({
      defaultProvider: client,
      providers: providerClients(client),
      registry: buildRegistry(),
      breaker: breaker(),
      catalog,
      now: clock(),
      signal: new AbortController().signal,
    });
    // Serve a plain (non-stream) request on the balanced head
    // deepseek/deepseek-v4-pro (json-capable, non-stream OK).
    const out = await execute(plan(["deepseek/deepseek-v4-pro"]), req());
    expect(out.final.status).toBe("ok");
    const served = out.attempts.find((a) => a.status === "ok");
    expect(served).toBeDefined();
    // pricing: input 0.435/MTok, output 0.87/MTok; usage 1000 prompt + 500 compl.
    // cost = 1000/1e6*0.435 + 500/1e6*0.87 = 0.000435 + 0.000435 = 0.00087.
    expect(served?.cost_usd).not.toBeNull();
    expect(served?.cost_usd).toBeCloseTo(0.00087, 9);
  });
});
