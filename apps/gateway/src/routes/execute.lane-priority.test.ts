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
  type CatalogEntry,
  createNativePassthroughCarrier,
  InternalRequestSchema,
  LanesConfigSchema,
} from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createExecute } from "./execute.js";

const CLAUDE = "anthropic/claude-sonnet-5-5";
const CODEX = "openai-codex/gpt-6.2-sol";
const KIMI = "kimi/k3.1-pro[1m]";
async function scenario(
  options: {
    enabled?: boolean;
    singleMember?: boolean;
    abortDiscovery?: boolean;
    abortCount?: boolean;
    promoted?: boolean;
    inspectProbe?: boolean;
    keyPreflight?: boolean;
    kimiLaneOnly?: boolean;
    codexFallback?: boolean;
    nestedPrimary?: boolean;
    defaults?: boolean;
    stream?: boolean;
    fail?: string[];
    blocked?: string[];
    noTools?: boolean;
    exactContext?: number;
    openClaude?: boolean;
    halfOpenClaude?: boolean;
    tripClaudeWhileKimiRuns?: boolean;
    withdrawClaudeDuringDiscovery?: boolean;
    replaceClaudeWhileKimiRuns?: boolean;
    discoveryFailure?: boolean;
    previousResponse?: boolean;
    kimiPriority?: number;
    claudePriorities?: number[];
  } = {},
) {
  const controller = new AbortController();
  const warnings: string[] = [];
  const probeAvailable: boolean[] = [];
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const client = (name: string, anthropic = false): ProviderClient => ({
    async chatCompletion(body) {
      if (name === "Kimi" && options.inspectProbe) {
        const gate = breaker.canAttempt(CLAUDE);
        probeAvailable.push(gate.allow);
        if (gate.probeToken) breaker.recordAbort(CLAUDE, gate.probeToken);
      }
      calls.push(name);
      bodies.push(body);
      if (name === "Kimi" && options.replaceClaudeWhileKimiRuns)
        providers.set("anthropic", {
          ...client("replacement", true),
          countTokens: async () => ({ input_tokens: 2000 }),
        });
      if (name === "Kimi" && options.tripClaudeWhileKimiRuns) breaker.recordFailure(CLAUDE);
      if (options.fail?.includes(name))
        throw new UpstreamError("upstream_error", "fixture unavailable", null, 503);
      return anthropic
        ? {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [{ type: "text", text: "OK" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
            id: "fixture",
            model: "k3.1-pro[1m]",
            choices: [
              { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
    },
    async *chatCompletionStream(body) {
      if (name === "Kimi" && options.inspectProbe) {
        const gate = breaker.canAttempt(CLAUDE);
        probeAvailable.push(gate.allow);
        if (gate.probeToken) breaker.recordAbort(CLAUDE, gate.probeToken);
      }
      calls.push(name);
      bodies.push(body);
      if (name === "Kimi" && options.replaceClaudeWhileKimiRuns)
        providers.set("anthropic", {
          ...client("replacement", true),
          countTokens: async () => ({ input_tokens: 2000 }),
        });
      if (name === "Kimi" && options.tripClaudeWhileKimiRuns) breaker.recordFailure(CLAUDE);
      if (options.fail?.includes(name))
        throw new UpstreamError("upstream_error", "fixture unavailable", null, 503);
      yield 'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n';
      yield "data: [DONE]\n\n";
    },
  });
  const oauth = createOAuthPoolClient({
    members: ["Claude-A", "Claude-B"].map((account, index) => ({
      account,
      priority: options.defaults ? 50 : (options.claudePriorities?.[index] ?? 30),
      schedulable: true,
      models: ["claude-sonnet-5-5"],
      client: client(account, true),
    })),
  });
  const countTokens = vi.fn(
    async (_body: unknown, _opts?: Parameters<NonNullable<ProviderClient["countTokens"]>>[1]) => {
      if (options.abortCount) {
        controller.abort();
        throw controller.signal.reason;
      }
      return { input_tokens: options.exactContext ?? 1 };
    },
  );
  if (options.exactContext !== undefined) oauth.countTokens = countTokens;
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
  const accounts = new ApiKeyAccounts({
    store,
    encKey: Buffer.alloc(32, 7),
    poolId: "kimi",
    timezone: "UTC",
  });
  await accounts.add([{ name: "Kimi", key: "sk-proj-synthetic-test-only" }]);
  const account = accounts.entries()[0];
  if (!account) throw new Error("fixture missing account");
  await accounts.update(account.id, {
    priority: options.defaults ? 50 : (options.kimiPriority ?? 10),
  });
  // Deliberately leave round_robin enabled: the lane opt-in overrides its priority gate.
  const kimi = createApiKeyPoolClient({
    accounts,
    models: ["k3.1-pro[1m]"],
    protocol: "openai_chat",
    createClient: () => client("Kimi"),
  });
  const exposed = new Set([CLAUDE, CODEX]);
  const priorityPool = oauth.accountPriority;
  if (!priorityPool) throw new Error("fixture missing OAuth pool metadata");
  const originalSnapshot = priorityPool.snapshot.bind(priorityPool);
  const snapshot = vi.spyOn(priorityPool, "snapshot");
  if (options.withdrawClaudeDuringDiscovery)
    snapshot.mockImplementationOnce(async (...args) => {
      const result = await originalSnapshot(...args);
      exposed.clear();
      return result;
    });
  if (options.abortDiscovery)
    snapshot.mockImplementationOnce(async (...args) => {
      const result = await originalSnapshot(...args);
      controller.abort();
      return result;
    });
  if (options.discoveryFailure)
    snapshot.mockRejectedValueOnce(new Error("transient discovery failure"));
  const lanes = LanesConfigSchema.parse({
    "claude-sonnet": {
      primary: options.nestedPrimary ? "claude-primary" : CLAUDE,
      shared_account_priority: options.enabled ?? true,
      fallback: [
        "anthropic-api/claude-sonnet-5-5",
        "zenmux-anthropic/claude-sonnet-5.5",
        ...(options.kimiLaneOnly ? [] : [KIMI]),
        "kimi",
        "balanced",
      ],
    },
    kimi: { primary: KIMI, fallback: ["kimi-tail/tail", "balanced"] },
    balanced: { primary: options.codexFallback ? "gpt-sol" : "tail/balanced", fallback: [] },
    "gpt-sol": { primary: CODEX, fallback: [] },
    "claude-primary": { primary: CLAUDE, fallback: [] },
  });
  if (options.singleMember) {
    const single = LanesConfigSchema.parse({
      single: { primary: CLAUDE, shared_account_priority: true },
    }).single;
    if (!single) throw new Error("missing single lane fixture");
    lanes["claude-sonnet"] = single;
  }
  if (options.promoted) {
    const lane = lanes["claude-sonnet"];
    if (lane) {
      lane.primary = KIMI;
      lane.fallback = [CLAUDE];
    }
  }
  const providers = new Map<string, ProviderClient>([
    ["anthropic", oauth],
    [
      "openai-codex",
      createOAuthPoolClient({
        members: [
          {
            account: "Codex",
            priority: 10,
            schedulable: true,
            models: ["gpt-6.2-sol"],
            client: client("Codex"),
          },
        ],
      }),
    ],
    ["kimi", kimi],
    ["anthropic-api", client("Claude-key", true)],
    ["zenmux-anthropic", client("Zenmux", true)],
    ["kimi-tail", client("Nested-tail")],
    ["tail", client("Balanced")],
  ]);
  const keySelected = vi.fn();
  const keyAccounts = new ApiKeyAccounts({
    store,
    encKey: Buffer.alloc(32, 7),
    poolId: "count-test",
    timezone: "UTC",
  });
  await keyAccounts.add([{ name: "count-key", key: "sk-proj-count-fixture" }]);
  const keyClient = createApiKeyPoolClient({
    accounts: keyAccounts,
    models: ["claude-sonnet-5-5"],
    protocol: "anthropic_messages",
    onSelect: keySelected,
    createClient: () => client("Count-key", true),
  });
  const keyCount = vi.fn(
    async (
      body: Parameters<ProviderClient["chatCompletion"]>[0],
      opts?: Parameters<ProviderClient["chatCompletion"]>[1],
    ) => {
      await keyClient.chatCompletion(body, opts);
      return { input_tokens: 1 };
    },
  );
  if (options.keyPreflight)
    providers.set(
      "anthropic-api",
      new Proxy(keyClient, {
        get(target, prop, receiver) {
          return prop === "countTokens" ? keyCount : Reflect.get(target, prop, receiver);
        },
      }),
    );
  const accountState = () => keyAccounts.entries().map(({ key: _key, ...account }) => account);
  const keyBefore = accountState();
  const priorityEvents: Record<string, unknown>[] = [];
  const catalog = new Map<string, CatalogEntry>();
  if (options.noTools)
    catalog.set(KIMI, {
      modelKey: KIMI,
      capabilities: {
        supportsTools: false,
        jsonOutput: "schema",
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 100000,
        maxOutputTokens: 4096,
      },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
      source: "generated",
    });
  if (options.exactContext !== undefined)
    catalog.set(CLAUDE, {
      modelKey: CLAUDE,
      capabilities: {
        supportsTools: true,
        jsonOutput: "schema",
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 1000,
        maxOutputTokens: 4096,
      },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
      source: "generated",
    });
  if (options.keyPreflight) {
    const entry = catalog.get(CLAUDE);
    if (entry)
      catalog.set("anthropic-api/claude-sonnet-5-5", {
        ...entry,
        modelKey: "anthropic-api/claude-sonnet-5-5",
      });
  }
  let clock = 0;
  const breaker = createCircuitBreaker({
    config: { failureThreshold: 1, cooldownMs: 1000 },
    now: () => clock,
  });
  if (options.openClaude || options.halfOpenClaude) breaker.recordFailure(CLAUDE);
  if (options.halfOpenClaude) clock = 1001;
  const execute = createExecute({
    log: (_level, event, fields) => {
      if (_level === "warn") warnings.push(event);
      if (event === "provider.account_priority") priorityEvents.push(fields);
    },
    defaultProvider: kimi,
    providers,
    knownOAuthPrefixes: new Set(["anthropic", "openai-codex"]),
    oauthAliases: () => exposed,
    oauthWireModels: () => new Map([[CLAUDE, "claude-sonnet-5-5"]]),
    oauthProviderProtocols: new Map([
      [
        "anthropic",
        {
          targetProviderProtocol: "anthropic_messages",
          providerRequiresCompatibilityRewrite: false,
        },
      ],
    ]),
    registry: {
      list: () => [],
      resolve: (alias) => {
        const [providerName, ...model] = alias.split("/");
        if (!providerName) throw new Error("fixture missing provider prefix");
        return {
          ok: true,
          value: {
            alias,
            providerName,
            providerModel: model.join("/"),
            baseUrl: "https://example.invalid",
            apiKeyEnv: "UNUSED",
            targetProviderProtocol:
              alias.startsWith("anthropic-api/") || alias.startsWith("zenmux-anthropic/")
                ? "anthropic_messages"
                : "openai_chat",
            providerRequiresCompatibilityRewrite: false,
          },
        };
      },
    },
    catalog,
    now: () => 0,
    breaker,
    signal: controller.signal,
  });
  const result = await routeRequest(
    InternalRequestSchema.parse({
      request_id: "lane-priority",
      protocol: "anthropic_messages",
      native_request:
        options.exactContext !== undefined
          ? createNativePassthroughCarrier({
              protocol: "anthropic_messages",
              headers: {},
              body: {
                model: "claude-sonnet",
                messages: [{ role: "user", content: "hello" }],
                max_tokens: 64,
              },
            })
          : undefined,
      account_id: "test",
      api_key_id: "test",
      user_id: null,
      org_id: null,
      requested_model: options.promoted ? "claude-sonnet-5-5" : "claude-sonnet",
      messages: [{ role: "user", content: "hello" }],
      tools: options.noTools
        ? [
            {
              type: "function",
              function: { name: "test", parameters: { type: "object", properties: {} } },
            },
          ]
        : null,
      provider_raw: options.previousResponse ? { previous_response_id: "resp_fixture" } : undefined,
      response_format: null,
      attachments: null,
      max_tokens: 64,
      metadata: {
        conversation_id: null,
        thread_id: null,
        resource_id: null,
        project_id: null,
        memory_mode: "off",
      },
      stream: options.stream ?? false,
    }),
    {
      lanes,
      modelAliases: { "claude-sonnet-5-5": "claude-sonnet" },
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
      log: () => {},
      now: () => new Date(0),
    },
    { allowCustomModel: true, keyCaps: { allowedLanes: null, blockedModels: options.blocked } },
  );
  let text = "";
  if (result.stream) for await (const chunk of result.stream) text += chunk;
  return {
    result,
    calls,
    bodies,
    text,
    snapshot,
    priorityEvents,
    countTokens,
    breaker,
    warnings,
    probeAvailable,
    keyCount,
    keySelected,
    keyBefore,
    keyAfter: accountState(),
  };
}

describe("lane account priority at the routing boundary", () => {
  it.each([
    false,
    true,
  ])("serves Kimi10 before Claude30 across protocols (stream=%s)", async (stream) => {
    const { result, calls, bodies, text } = await scenario({ stream });
    expect(calls).toEqual(["Kimi"]);
    expect(result.decision.final.model_alias).toBe(KIMI);
    expect(bodies[0]).toMatchObject({
      model: "k3.1-pro[1m]",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.decision.provider_attempts.at(-1)).toMatchObject({
      source_protocol: "anthropic_messages",
      target_provider_protocol: "openai_chat",
    });
    if (stream) expect(text).toContain("OK");
  });
  it("keeps old order when disabled", async () => {
    expect((await scenario({ enabled: false })).calls).toEqual(["Claude-A"]);
  });
  it("keeps chain order when enabled with all priorities at 50", async () => {
    expect((await scenario({ defaults: true })).calls).toEqual(["Claude-A"]);
  });
  it("keeps blocked direct aliases out of the group", async () => {
    expect((await scenario({ blocked: [KIMI] })).calls).toEqual(["Claude-A"]);
  });
});

describe("lane group boundaries", () => {
  const failedHeads = ["Claude-A", "Claude-B", "Claude-key", "Zenmux", "Kimi"];
  it("keeps the entire expanded chain order at default priorities, including nested fallbacks", async () => {
    const { calls, priorityEvents } = await scenario({ defaults: true, fail: failedHeads });
    expect(calls).toEqual([...failedHeads, "Nested-tail"]);
    expect(priorityEvents).toEqual([]);
  });
  it("groups direct Kimi but retains nested expansion order after the group", async () => {
    const { calls } = await scenario({ fail: [...failedHeads, "Balanced"] });
    expect(calls).toEqual(["Kimi", "Claude-A", "Claude-B", "Claude-key", "Zenmux", "Nested-tail"]);
  });
  it("interleaves pool siblings across different models", async () => {
    const { calls } = await scenario({
      claudePriorities: [10, 30],
      kimiPriority: 20,
      fail: ["Claude-A", "Kimi"],
    });
    expect(calls).toEqual(["Claude-A", "Kimi", "Claude-B"]);
  });
  it("gives static providers priority 50", async () => {
    expect((await scenario({ claudePriorities: [60, 70], kimiPriority: 80 })).calls).toEqual([
      "Claude-key",
    ]);
  });
  it("excludes a capability-filtered alias before grouping", async () => {
    const { calls, result, priorityEvents } = await scenario({ noTools: true });
    expect(calls).toEqual(["Claude-A"]);
    expect(result.decision.provider_attempts.some((attempt) => attempt.alias === KIMI)).toBe(false);
    expect(priorityEvents.some((event) => event.alias === KIMI)).toBe(false);
  });
  it.each([
    { discoveryFailure: true },
    { previousResponse: true },
  ])("uses legacy order on discovery failure or strict affinity: %j", async (options) => {
    const { calls, priorityEvents } = await scenario(options);
    expect(calls).toEqual(["Claude-A"]);
    expect(priorityEvents).toEqual([]);
  });
});

describe("lane preflight ownership", () => {
  it("does not call count_tokens behind an OPEN breaker", async () => {
    const { calls, countTokens } = await scenario({ exactContext: 1, openClaude: true });
    expect(calls).toEqual(["Kimi"]);
    expect(countTokens).not.toHaveBeenCalled();
  });
  it("never holds an unreached HALF_OPEN probe while a peer runs", async () => {
    const { breaker, countTokens, probeAvailable } = await scenario({
      exactContext: 1,
      halfOpenClaude: true,
      inspectProbe: true,
    });
    expect(countTokens).not.toHaveBeenCalled();
    expect(probeAvailable).toEqual([true]);
    expect(breaker.canAttempt(CLAUDE).allow).toBe(true);
  });
  it("checks exact context lazily with the cursor and advances on overflow", async () => {
    const { countTokens, priorityEvents, result } = await scenario({
      exactContext: 2000,
      claudePriorities: [1, 2],
    });
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(countTokens.mock.calls[0]?.[1]?.accountPriorityCursor).toBeDefined();
    expect(priorityEvents.some((event) => event.alias === CLAUDE)).toBe(false);
    expect(result.decision.provider_attempts).toContainEqual(
      expect.objectContaining({ alias: CLAUDE, skip_reason: "context_too_small" }),
    );
    expect(result.decision.final.model_alias).toBe(KIMI);
  });
  it("reuses a successful preflight when the alias is served", async () => {
    const { calls, countTokens } = await scenario({ exactContext: 1, claudePriorities: [1, 2] });
    expect(calls).toEqual(["Claude-A"]);
    expect(countTokens).toHaveBeenCalledTimes(1);
  });
});

it("rechecks a previously CLOSED breaker after another alias runs", async () => {
  const { calls, result } = await scenario({ fail: ["Kimi"], tripClaudeWhileKimiRuns: true });
  expect(calls).toEqual(["Kimi", "Claude-key"]);
  expect(result.decision.provider_attempts).toContainEqual(
    expect.objectContaining({ alias: CLAUDE, skip_reason: "circuit_open" }),
  );
});

it("revalidates live curation before exact-count preflight", async () => {
  const { calls, countTokens } = await scenario({
    exactContext: 1,
    withdrawClaudeDuringDiscovery: true,
  });
  expect(calls).toEqual(["Kimi"]);
  expect(countTokens).not.toHaveBeenCalled();
});
it("does not reuse preflight validation for a replacement provider", async () => {
  const { calls, result } = await scenario({
    exactContext: 1,
    replaceClaudeWhileKimiRuns: true,
    fail: ["Kimi"],
  });
  expect(calls).toEqual(["Kimi", "Claude-key"]);
  expect(result.decision.provider_attempts).toContainEqual(
    expect.objectContaining({ alias: CLAUDE, skip_reason: "context_too_small" }),
  );
});

describe("direct-only lane membership", () => {
  it.each([
    false,
    true,
  ])("keeps balanced → gpt-sol → Codex10 out of the Claude group (stream=%s)", async (stream) => {
    const { calls, priorityEvents } = await scenario({
      codexFallback: true,
      kimiLaneOnly: true,
      kimiPriority: 80,
      stream,
    });
    expect(calls).toEqual(["Claude-A"]);
    expect(priorityEvents.some((event) => event.alias === CODEX || event.alias === KIMI)).toBe(
      false,
    );
  });
  it.each([
    false,
    true,
  ])("allows directly listed Kimi10 before Claude30 (stream=%s)", async (stream) => {
    const { calls } = await scenario({ codexFallback: true, stream });
    expect(calls).toEqual(["Kimi"]);
  });
  it("does not treat a kimi lane reference as a member", async () => {
    expect((await scenario({ kimiLaneOnly: true })).calls).toEqual(["Claude-A"]);
  });
  it("still reaches nested Kimi then Codex in expanded fallback order after the direct group fails", async () => {
    const { calls, priorityEvents } = await scenario({
      kimiLaneOnly: true,
      codexFallback: true,
      fail: ["Claude-A", "Claude-B", "Claude-key", "Zenmux", "Kimi", "Nested-tail"],
    });
    expect(calls).toEqual([
      "Claude-A",
      "Claude-B",
      "Claude-key",
      "Zenmux",
      "Kimi",
      "Nested-tail",
      "Codex",
    ]);
    expect(priorityEvents.some((event) => event.alias === CODEX || event.alias === KIMI)).toBe(
      false,
    );
  });
  it("keeps a leading lane-name expansion before the first direct group member", async () => {
    expect((await scenario({ nestedPrimary: true })).calls).toEqual(["Claude-A"]);
  });
});

describe("lazy lane preflight", () => {
  it("does no exact counts or account selection for an unreached round-robin key", async () => {
    const f = await scenario({ exactContext: 1, keyPreflight: true });
    expect(f.calls).toEqual(["Kimi"]);
    expect(f.countTokens).not.toHaveBeenCalled();
    expect(f.keyCount).not.toHaveBeenCalled();
    expect(f.keySelected).not.toHaveBeenCalled();
    expect(f.keyAfter).toEqual(f.keyBefore);
  });
  it("records a filtered alias only when fallback reaches it", async () => {
    const { result } = await scenario({
      noTools: true,
      fail: ["Claude-A", "Claude-B", "Claude-key", "Zenmux"],
    });
    expect(result.decision.provider_attempts.map((row) => row.alias)).toEqual([
      CLAUDE,
      "anthropic-api/claude-sonnet-5-5",
      "zenmux-anthropic/claude-sonnet-5.5",
      KIMI,
      "kimi-tail/tail",
    ]);
    expect(result.decision.provider_attempts.find((row) => row.alias === KIMI)?.skip_reason).toBe(
      "no_tool_support",
    );
  });
  it("bypasses discovery and coordinator for a single direct member", async () => {
    const { calls, snapshot, priorityEvents, countTokens } = await scenario({
      singleMember: true,
      exactContext: 1,
    });
    expect(calls).toEqual(["Claude-A"]);
    expect(snapshot).not.toHaveBeenCalled();
    expect(priorityEvents).toEqual([]);
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(countTokens.mock.calls[0]?.[1]?.accountPriorityCursor).toBeUndefined();
  });
  it.each([
    { abortDiscovery: true },
    { abortCount: true, claudePriorities: [1, 2] },
  ])("stops preflight on client abort without warning: %j", async (options) => {
    const { calls, countTokens, warnings, result } = await scenario({
      ...options,
      exactContext: 1,
    });
    expect(calls).toEqual([]);
    if ("abortDiscovery" in options) expect(countTokens).not.toHaveBeenCalled();
    expect(warnings).not.toContain("anthropic.count_tokens_preflight_failed");
    expect(result.decision.final.status).toBe("error");
  });
  it("allows priority to override a client-promoted model inside the lane group", async () => {
    const { calls, result } = await scenario({ promoted: true });
    expect(result.decision.lane.candidate_chain[0]).toBe(CLAUDE);
    expect(calls).toEqual(["Kimi"]);
  });
});

it.each([
  true,
  false,
])("preserves capability-unsatisfiable when every reached alias is filtered (flag=%s)", async (enabled) => {
  const { result } = await scenario({
    enabled,
    noTools: true,
    blocked: ["anthropic/*", "anthropic-api/*", "zenmux-anthropic/*", "kimi-tail/*", "tail/*"],
  });
  expect(result.error?.error_class).toBe("capability_unsatisfiable");
});
