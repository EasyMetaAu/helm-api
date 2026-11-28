import {
  ApiKeyAccounts,
  type ConfigStore,
  createApiKeyPoolClient,
  createCircuitBreaker,
  createOAuthPoolClient,
  type ProviderClient,
  routeRequest,
  UpstreamError,
} from "@helm/core";
import {
  createNativePassthroughCarrier,
  InternalRequestSchema,
  LanesConfigSchema,
} from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  markServingAccount,
  stampServingAccount,
  withServingAccountCapture,
} from "../runtime/serving-account.js";
import { createExecute } from "./execute.js";

function seeded(seed = 12345) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
async function fixture(
  options: {
    sameWire?: boolean;
    fail?: string[];
    random?: () => number;
    defaults?: boolean;
    singleTier?: boolean;
    staticTier?: boolean;
    legacyKey?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const events: Record<string, unknown>[] = [];
  const client = (name: string): ProviderClient => ({
    async chatCompletion() {
      calls.push(name);
      if (options.fail?.includes(name))
        throw new UpstreamError("upstream_error", "synthetic pre-output fault", null, 503);
      return { id: "test", choices: [{ index: 0, message: { role: "assistant", content: "OK" } }] };
    },
    async *chatCompletionStream() {
      calls.push(name);
      if (options.fail?.includes(name))
        throw new UpstreamError("upstream_error", "synthetic pre-output fault", null, 503);
      yield 'data: {"id":"test","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n';
      yield "data: [DONE]\n\n";
    },
  });
  let busy = false;
  const members = ["A", "B"].map((account) => ({
    account,
    priority: options.defaults ? 50 : options.staticTier ? 60 : 10,
    schedulable: true,
    isAtCapacity: () => busy && account === "A",
    models: ["m"],
    client: client(account),
  }));
  const oauth = createOAuthPoolClient({
    members,
    onSelect: (account) => markServingAccount("openai-codex", account),
  });
  const data = new Map<string, string>();
  const store: ConfigStore = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
    compareAndSet: async (k, e, v) => {
      if ((data.get(k) ?? null) !== e) return false;
      data.set(k, v);
      return true;
    },
  };
  const keys = new Map<string, ProviderClient>();
  for (const [name, model, priority] of [
    ["api", "m", options.singleTier ? 20 : 10],
    ["zen", "vendor/m", 10],
    ["kimi", "k", 20],
  ] as const) {
    const accounts = new ApiKeyAccounts({
      store,
      encKey: Buffer.alloc(32, 7),
      poolId: name,
      timezone: "UTC",
    });
    await accounts.add([{ name, key: `sk-proj-synthetic-${name}` }]);
    const account = accounts.entries()[0];
    if (!account) throw new Error("fixture account missing");
    await accounts.update(account.id, { priority: options.defaults ? 50 : priority });
    await accounts.setStrategy("manual_priority");
    keys.set(
      name,
      createApiKeyPoolClient({
        accounts,
        models: [model],
        protocol: "openai_chat",
        createClient: () => client(name),
        onSelect: (account) => markServingAccount(name, account),
      }),
    );
  }
  const providers = new Map([["openai-codex", oauth], ...keys]);
  if (options.staticTier) {
    providers.set(
      "api",
      options.legacyKey
        ? createApiKeyPoolClient({
            accounts: new ApiKeyAccounts({
              store,
              encKey: Buffer.alloc(32, 7),
              poolId: "legacy",
              timezone: "UTC",
            }),
            models: ["m"],
            protocol: "openai_chat",
            createClient: () => client("api"),
            legacyClient: client("api"),
          })
        : client("api"),
    );
    providers.set("zen", client("zen"));
  }
  const chain =
    options.sameWire || options.singleTier
      ? ["openai-codex/m", "api/m"]
      : options.staticTier
        ? ["openai-codex/m", "api/m", "zen/vendor/m"]
        : ["openai-codex/m", "api/m", "zen/vendor/m", "kimi/k"];
  const lanes = LanesConfigSchema.parse({
    balanced: {
      primary: chain[0],
      fallback: chain.slice(1),
      shared_account_priority: !options.sameWire,
    },
  });
  const random = options.random ?? seeded();
  const run = async (stream = false, session?: string, native = false) => {
    calls.length = 0;
    events.length = 0;
    const execute = createExecute({
      defaultProvider: oauth,
      providers,
      accountPriorityRandom: random,
      log: (_level, event, fields) => {
        if (event === "provider.account_priority") events.push(fields);
      },
      registry: {
        list: () => chain,
        resolve: (alias) => {
          const [providerName, ...model] = alias.split("/");
          if (!providerName) throw new Error("missing prefix");
          return {
            ok: true,
            value: {
              alias,
              providerName,
              providerModel: model.join("/"),
              targetProviderProtocol: "openai_chat",
              providerRequiresCompatibilityRewrite: false,
              baseUrl: "https://example.invalid",
              apiKeyEnv: "UNUSED",
            },
          };
        },
      },
      catalog: new Map(),
      breaker: createCircuitBreaker({
        config: { failureThreshold: 5, cooldownMs: 1000 },
        now: () => 0,
      }),
      signal: new AbortController().signal,
      now: () => 0,
    });
    const req = InternalRequestSchema.parse({
      request_id: "tier-share",
      protocol: native ? "openai_responses" : "openai_chat",
      account_id: "fixture",
      api_key_id: "fixture",
      user_id: null,
      org_id: null,
      requested_model: "balanced",
      messages: [{ role: "user", content: "hello" }],
      tools: null,
      response_format: null,
      attachments: null,
      max_tokens: null,
      stream,
      metadata: {
        conversation_id: null,
        thread_id: null,
        resource_id: null,
        project_id: null,
        memory_mode: "off",
      },
      prompt_cache_key: session && !native ? session : undefined,
      native_request:
        session && native
          ? createNativePassthroughCarrier({
              protocol: "openai_responses",
              headers: { "session-id": session },
              body: { model: "balanced", messages: [{ role: "user", content: "hello" }] },
            })
          : undefined,
    });
    const captured = await withServingAccountCapture(() =>
      routeRequest(
        req,
        {
          lanes,
          policies: { policies: [] },
          classify: async () => ({
            task_type: "chat",
            complexity: "medium",
            confidence: 0,
            decided_by: "fallback",
            fallback_reason: "eval_disabled",
            constraints: {},
            explanation: [],
          }),
          execute,
          now: () => new Date(0),
          log: () => {},
        },
        { allowCustomModel: true },
      ),
    );
    const result = captured.result;
    stampServingAccount(result.decision, captured.servingAccount);
    if (result.stream)
      for await (const _ of result.stream) {
      }
    return { calls: [...calls], events: [...events], result, req };
  };
  return {
    run,
    members,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}
function pool(account: string | undefined) {
  return account === "A" || account === "B" ? "oauth" : account;
}

describe("equal-priority sharing through real gateway and pools", () => {
  it.each([false, true])("shares 2:1:1 without using tier20 (stream=%s)", async (stream) => {
    const f = await fixture();
    const counts = { oauth: 0, api: 0, zen: 0 };
    for (let i = 0; i < 400; i++) {
      const r = await f.run(stream);
      expect(r.result.final.status).toBe("ok");
      const winner = pool(r.calls[0]);
      expect(r.result.decision.serving_account?.provider_id).toBe(
        winner === "oauth" ? "openai-codex" : winner,
      );
      expect(["oauth", "api", "zen"]).toContain(winner);
      counts[winner as keyof typeof counts]++;
      expect(r.events[0]).toMatchObject({
        pool_selection_reason: "weighted_random",
        pool_weight: winner === "oauth" ? 2 : 1,
        tier_pool_count: 3,
        affinity_hash: null,
      });
    }
    expect(counts.oauth).toBeGreaterThan(160);
    expect(counts.oauth).toBeLessThan(240);
    expect(counts.api).toBeGreaterThan(65);
    expect(counts.api).toBeLessThan(135);
    expect(counts.zen).toBeGreaterThan(65);
    expect(counts.zen).toBeLessThan(135);
    expect(counts).toEqual({ oauth: 198, api: 90, zen: 112 });
  });
  it.each([
    false,
    true,
  ])("uses existing soft session signal deterministically (native=%s)", async (native) => {
    const f = await fixture();
    const winners = new Set<string | undefined>();
    for (let i = 0; i < 24; i++) {
      const session = `synthetic-session-${i}`;
      const first = await f.run(false, session, native);
      winners.add(pool(first.calls[0]));
      for (let j = 0; j < 3; j++)
        expect(pool((await f.run(false, session, native)).calls[0])).toBe(pool(first.calls[0]));
      expect(JSON.stringify(first.events)).not.toContain(session);
      expect(first.events[0]).toMatchObject({
        pool_selection_reason: "sticky",
        affinity_hash: expect.stringMatching(/^[a-f0-9]{16}$/),
      });
    }
    expect(winners.size).toBe(3);
  });
  it.each([
    false,
    true,
  ])("tries other pools at the same tier before the failed pool sibling (stream=%s)", async (stream) => {
    const f = await fixture({ random: () => 0.5, fail: ["A", "api"] });
    const r = await f.run(stream);
    expect(r.calls).toEqual(["A", "api", "zen"]);
  });
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])("records a chosen static member (key proxy=%s, stream=%s)", async (legacyKey, stream) => {
    const f = await fixture({ staticTier: true, legacyKey, random: () => 0.5 });
    const r = await f.run(stream);
    expect(r.calls).toEqual(["api"]);
    expect(r.events).toEqual([
      expect.objectContaining({
        pool: "api",
        account: "static",
        priority: 50,
        pool_selection_reason: "weighted_random",
        pool_weight: 1,
        tier_pool_count: 2,
      }),
    ]);
  });
  it("keeps session pool choice and weight when one subscription account becomes busy", async () => {
    const f = await fixture();
    const idlePools: (string | undefined)[] = [];
    const busyPools: (string | undefined)[] = [];
    const weights: [unknown, unknown][] = [];
    for (let i = 0; i < 40; i++) {
      const session = `capacity-session-${i}`;
      f.setBusy(false);
      const idle = await f.run(false, session);
      f.setBusy(true);
      const busy = await f.run(false, session);
      idlePools.push(pool(idle.calls[0]));
      busyPools.push(pool(busy.calls[0]));
      weights.push([idle.events[0]?.pool_weight, busy.events[0]?.pool_weight]);
      if (pool(busy.calls[0]) === "oauth") expect(busy.calls).toEqual(["B"]);
    }
    expect(busyPools).toEqual(idlePools);
    for (const [idle, busy] of weights) expect(busy).toBe(idle);
  });
  it.each([
    false,
    true,
  ])("returns no soft affinity on invalid Anthropic identity (native=%s)", async (native) => {
    const f = await fixture();
    const { req } = await f.run();
    const malformed = { metadata: { user_id: JSON.stringify({ account_uuid: "invalid" }) } };
    const oauth = createOAuthPoolClient({
      members: f.members.map((member) => ({
        ...member,
        client: { ...member.client, nativeProtocolProfile: "anthropic_messages" },
      })),
    });
    const request = {
      ...req,
      provider_raw: native ? undefined : malformed,
      native_request: native
        ? createNativePassthroughCarrier({
            protocol: "anthropic_messages",
            headers: {},
            body: malformed,
          })
        : undefined,
    };
    expect(oauth.accountPriority?.affinityHash?.(request)).toBeNull();
    // Discovery must not hide the invalid identity from the dispatch boundary.
    expect(oauth.accountPriority?.isPinned(request)).toBe(true);
  });
  it("also shares the #1070 same-wire group 2:1", async () => {
    const f = await fixture({ sameWire: true });
    let api = 0;
    for (let i = 0; i < 300; i++) if (pool((await f.run()).calls[0]) === "api") api++;
    expect(api).toBeGreaterThan(65);
    expect(api).toBeLessThan(135);
  });
  it("preserves all-default bypass and single-pool tiers", async () => {
    for (const options of [{ defaults: true }, { singleTier: true }]) {
      const f = await fixture(options);
      for (let i = 0; i < 12; i++) expect(pool((await f.run()).calls[0])).toBe("oauth");
    }
  });
});
