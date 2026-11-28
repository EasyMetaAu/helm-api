import {
  ApiKeyAccounts,
  type ConfigStore,
  createApiKeyPoolClient,
  createCircuitBreaker,
  createOAuthPoolClient,
  createOpenAIClient,
  type OAuthPoolMember,
  type ProviderClient,
  type ProviderRegistry,
  preOutputClassifierFor,
  routeRequest,
  UpstreamError,
} from "@helm/core";
import {
  createNativePassthroughCarrier,
  type InternalRequest,
  InternalRequestSchema,
  LanesConfigSchema,
} from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markServingAccount,
  stampServingAccount,
  withServingAccountCapture,
} from "../runtime/serving-account.js";
import { createExecute } from "./execute.js";

const MODEL = "gpt-test";
const OAUTH_ALIAS = `openai-codex/${MODEL}`;
const KEY_ALIAS = `openai/${MODEL}`;

afterEach(() => vi.useRealTimers());
type ProviderCallOptions = NonNullable<Parameters<ProviderClient["chatCompletion"]>[1]>;
interface Scenario {
  wallClock?: boolean;
  nestedLanePriority?: "no-direct" | "with-direct";
  keyStrategy?: "round_robin" | "manual_priority";
  keyModel?: string;
  chain?: [string, ...string[]];
  roundRobinBetween?: boolean;
  success?: string;
  blockedModels?: string[];
  allowCustomModel?: boolean;
  native?: boolean;
  error?: UpstreamError;
  beforeReply?: (name: string, opts?: ProviderCallOptions) => Promise<void>;
  attemptMs?: number;
  firstOutputMs?: number;
  afterOutputFailure?: boolean;
  extraAccount?: boolean;
  free?: boolean;
  busyA?: boolean;
  spendingA?: boolean;
  echoedCredential?: string;
}
async function fixture(stream: boolean, scenario: Scenario = {}) {
  const oauthAlias = scenario.free ? `${OAUTH_ALIAS}:free` : OAUTH_ALIAS;
  const calls: string[] = [];
  const data = new Map<string, string>();
  const store: ConfigStore = {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    compareAndSet: async (key, expected, value) => {
      if ((data.get(key) ?? null) !== expected) return false;
      data.set(key, value);
      return true;
    },
  };
  const accounts = new ApiKeyAccounts({
    store,
    encKey: Buffer.alloc(32, 7),
    poolId: "openai",
    timezone: "UTC",
  });
  await accounts.add([
    { name: "key-A", key: "sk-proj-synthetic-priority-a" },
    { name: "key-B", key: "sk-proj-synthetic-priority-b" },
  ]);
  const [keyA, keyB] = accounts.entries();
  if (!keyA || !keyB) throw new Error("missing fixture accounts");
  await accounts.update(keyA.id, { priority: 20 });
  await accounts.update(keyB.id, { enabled: false });
  await accounts.setStrategy(scenario.keyStrategy ?? "manual_priority");

  const client = (name: string): ProviderClient => {
    if (name === "subscription-A" && scenario.echoedCredential) {
      return createOpenAIClient({
        config: { baseUrl: "https://example.invalid/v1", apiKey: scenario.echoedCredential },
        fetch: async () => {
          calls.push(name);
          return new Response(
            `data: ${JSON.stringify({ error: { message: `provider echoed ${scenario.echoedCredential}`, detail: "fixture" } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
    }
    const call = async (opts?: ProviderCallOptions) => {
      calls.push(name);
      await scenario.beforeReply?.(name, opts);
      opts?.signal?.throwIfAborted();
      if (name !== (scenario.success ?? "subscription-B")) {
        throw (
          scenario.error ??
          new UpstreamError("upstream_error", "synthetic pre-output fault", null, 503)
        );
      }
      return {
        id: "synthetic-result",
        model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    };
    return {
      nativeProtocolProfile: scenario.native
        ? name.startsWith("key")
          ? "generic_openai_responses"
          : "codex_responses"
        : undefined,
      async nativePassthrough(_body, opts) {
        await call(opts);
        return {
          id: "resp_fixture",
          object: "response",
          status: "completed",
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
          ],
        };
      },
      async *nativePassthroughStream(_body, opts) {
        yield 'data: {"type":"response.created","response":{"id":"resp_fixture"}}\n\n';
        await call(opts);
        yield 'data: {"type":"response.output_text.delta","delta":"OK"}\n\n';
        if (scenario.afterOutputFailure)
          throw new UpstreamError("upstream_error", "late failure", null, 503);
        yield 'data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed"}}\n\n';
      },
      chatCompletion: async (_body, opts) => call(opts),
      async *chatCompletionStream(_body, opts) {
        await call(opts);
        yield 'data: {"id":"synthetic-result","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n';
        if (scenario.afterOutputFailure)
          throw new UpstreamError("upstream_error", "late failure", null, 503);
        yield "data: [DONE]\n\n";
      },
    };
  };
  const members: OAuthPoolMember[] = [
    "subscription-A",
    "subscription-B",
    ...(scenario.extraAccount ? ["subscription-C"] : []),
  ].map((account, index) => ({
    account,
    priority: index === 0 ? 10 : index === 1 ? 30 : 40,
    schedulable: true,
    models: [MODEL],
    client: client(account),
    ...(index === 0 && scenario.busyA ? { isAtCapacity: () => true } : {}),
    ...(index === 0 && scenario.spendingA
      ? { usageLimitedUntilMs: Date.now() + 60000, allowSpendRemainingCredits: true }
      : {}),
  }));
  const oauth = createOAuthPoolClient({
    onSelect: (account) => markServingAccount("openai-codex", account),
    nativeStreamPreambleClassifier: preOutputClassifierFor("openai_responses"),
    chatStreamPreambleClassifier: preOutputClassifierFor("openai_chat"),
    members,
  });
  const keyClient = createApiKeyPoolClient({
    accounts,
    onSelect: (account) => markServingAccount("openai", account, [KEY_ALIAS]),
    models: [scenario.keyModel ?? MODEL],
    protocol: scenario.native ? "openai_responses" : "openai_chat",
    createClient: (_key, account) => client(account?.name ?? "key-template"),
  });
  const keyPriority = keyClient.accountPriority;
  if (!keyPriority || !oauth.accountPriority) throw new Error("missing priority metadata");
  const originalKeySnapshot = keyPriority.snapshot.bind(keyPriority);
  const keySnapshot = vi.spyOn(keyPriority, "snapshot");
  const oauthSnapshot = vi.spyOn(oauth.accountPriority, "snapshot");
  const keys = new Proxy(keyClient, {
    get(target, property, receiver) {
      return property === "accountPriority" ? keyPriority : Reflect.get(target, property, receiver);
    },
  });
  const roundRobinAccounts = new ApiKeyAccounts({
    store,
    encKey: Buffer.alloc(32, 7),
    poolId: "rr",
    timezone: "UTC",
  });
  if (scenario.roundRobinBetween) {
    await roundRobinAccounts.add([{ name: "rr-account", key: "sk-proj-synthetic-rr" }]);
    const account = roundRobinAccounts.entries()[0];
    if (!account) throw new Error("missing rr account");
    await roundRobinAccounts.update(account.id, { priority: 1 });
  }
  const roundRobin = createApiKeyPoolClient({
    accounts: roundRobinAccounts,
    models: [MODEL],
    protocol: "openai_chat",
    createClient: () => client("rr-account"),
  });
  const registry: ProviderRegistry = {
    list: () => [KEY_ALIAS],
    resolve: (alias) =>
      alias === KEY_ALIAS || alias === `${KEY_ALIAS}-mirror`
        ? {
            ok: true,
            value: {
              alias,
              providerName: "openai",
              providerModel: scenario.keyModel ?? MODEL,
              baseUrl: "https://example.invalid/v1",
              apiKeyEnv: "UNUSED_SYNTHETIC_KEY",
              targetProviderProtocol: scenario.native ? "openai_responses" : "openai_chat",
              providerRequiresCompatibilityRewrite: false,
            },
          }
        : { ok: false, error: { kind: "unknown_alias", alias } },
  };
  const chain: [string, ...string[]] = scenario.chain ?? [
    oauthAlias,
    ...(scenario.roundRobinBetween ? [`rr/${MODEL}`] : []),
    KEY_ALIAS,
  ];
  let clock = 0;
  const controller = new AbortController();
  const breaker = createCircuitBreaker({
    config: { failureThreshold: 1, cooldownMs: 1000 },
    now: () => (scenario.wallClock ? Date.now() : clock),
  });
  const priorityEvents: Record<string, unknown>[] = [];
  const execute = createExecute({
    log: (_level, event, fields) => {
      if (event === "provider.account_priority") priorityEvents.push(fields);
    },
    defaultProvider: keys,
    providers: new Map([
      [
        "direct",
        {
          ...client("direct-failure"),
          accountPriority: {
            kind: "oauth",
            snapshot: async () => [{ account: "direct", priority: 5, eligible: true }],
            isPinned: () => false,
          },
        },
      ],
      ["rr", roundRobin],
      ["openai", keys],
      ["openai-codex", oauth],
    ]),
    registry,
    knownOAuthPrefixes: new Set(["openai-codex"]),
    oauthAliases: () => new Set([oauthAlias]),
    oauthWireModels: () => new Map([[oauthAlias, MODEL]]),
    oauthProviderProtocols: new Map([
      [
        "openai-codex",
        {
          targetProviderProtocol: scenario.native ? "openai_responses" : "openai_chat",
          providerRequiresCompatibilityRewrite: false,
        },
      ],
    ]),
    nativeProtocolPassthroughEnabled: () => true,
    firstOutputTimeoutMs: scenario.firstOutputMs,
    catalog: new Map(),
    breaker,
    now: () => (scenario.wallClock ? Date.now() : clock),
    signal: controller.signal,
  });
  const run = async (overrides: Partial<InternalRequest> = {}) => {
    const captured = await withServingAccountCapture(() =>
      routeRequest(
        InternalRequestSchema.parse({
          request_id: "shared-priority",
          ...(scenario.native
            ? {
                native_request: createNativePassthroughCarrier({
                  protocol: "openai_responses",
                  headers: {},
                  body: { model: MODEL, input: "hello", stream },
                }),
              }
            : {}),
          ...(scenario.attemptMs ? { attempt_timeout_ms: scenario.attemptMs } : {}),
          protocol: scenario.native ? "openai_responses" : "openai_chat",
          account_id: "test-owner",
          api_key_id: "test-key-id",
          user_id: null,
          org_id: null,
          requested_model: "auto",
          messages: [{ role: "user", content: "hello" }],
          tools: null,
          response_format: null,
          attachments: null,
          max_tokens: null,
          metadata: {
            conversation_id: null,
            thread_id: null,
            resource_id: null,
            project_id: null,
            memory_mode: "off",
          },
          stream,
          ...overrides,
        }),
        {
          classify: async () => ({
            task_type: "chat",
            complexity: "medium",
            confidence: 0,
            decided_by: "fallback",
            fallback_reason: "eval_disabled",
            constraints: {},
            explanation: [],
          }),
          policies: { policies: [] },
          lanes: LanesConfigSchema.parse({
            balanced: scenario.nestedLanePriority
              ? {
                  shared_account_priority: true,
                  primary:
                    scenario.nestedLanePriority === "no-direct" ? "nested" : "direct/fixture",
                  fallback:
                    scenario.nestedLanePriority === "no-direct" ? [] : ["direct/other", "nested"],
                }
              : { primary: chain[0], fallback: chain.slice(1) },
            ...(scenario.nestedLanePriority
              ? { nested: { primary: chain[0], fallback: chain.slice(1) } }
              : {}),
          }),
          execute,
          now: () => new Date(0),
          log: () => {},
        },
        {
          allowCustomModel: scenario.allowCustomModel,
          keyCaps: { allowedLanes: null, blockedModels: scenario.blockedModels },
        },
      ),
    );
    stampServingAccount(captured.result.decision, captured.servingAccount);
    return captured.result;
  };
  return {
    calls,
    keySnapshot,
    originalKeySnapshot,
    oauthSnapshot,
    members,
    store,
    priorityEvents,
    run,
    chain,
    breaker,
    controller,
    oauth,
    accounts,
    keyA,
    advanceClock: () => {
      clock += 1001;
    },
  };
}

describe("shared subscription/API-key priority", () => {
  it.each([false, true])("tries A10 -> K20 -> B30 (stream=%s)", async (stream) => {
    const { calls, run, breaker } = await fixture(stream);
    const result = await run();
    if (result.stream) {
      for await (const _chunk of result.stream) {
        // Finish the serving stream.
      }
    }
    expect(calls).toEqual(["subscription-A", "key-A", "subscription-B"]);
    expect(result.decision.final.status).toBe("ok");
    expect(result.decision.fallback_count).toBe(1);
    expect(result.decision.classifier).toMatchObject({
      decided_by: "fallback",
      fallback_reason: "eval_disabled",
    });
    expect(breaker.getState(OAUTH_ALIAS)).toBe("CLOSED");
    expect(breaker.getState(KEY_ALIAS)).toBe("OPEN");
  });
});

it.each([
  false,
  true,
])("early key success cleans up HALF_OPEN OAuth without a false failure (stream=%s)", async (stream) => {
  const f = await fixture(stream, { success: "key-A" });
  f.breaker.recordFailure(OAUTH_ALIAS);
  f.advanceClock();
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "key-A"]);
  expect(result.decision.final.status).toBe("ok");
  expect(result.decision.serving_account?.provider_id).toBe("openai");
  expect(result.decision.fallback_count).toBe(1);
  expect(result.decision.provider_attempts.at(-1)?.alias).toBe(KEY_ALIAS);
  expect(f.breaker.canAttempt(OAUTH_ALIAS)).toMatchObject({ allow: true, probe: true });
  f.breaker.recordAbort(OAUTH_ALIAS);
  if (result.stream)
    for await (const _chunk of result.stream) {
      /* drain */
    }
});

it.each([false, true])("real 400 terminates without trying peers (stream=%s)", async (stream) => {
  const f = await fixture(stream, {
    error: new UpstreamError(
      "upstream_error",
      "Invalid value for temperature",
      {
        error: {
          type: "invalid_request_error",
          message: "Invalid value for temperature",
          param: "temperature",
        },
      },
      400,
    ),
  });
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A"]);
  expect(result.error?.error_class).toBe("invalid_request");
  expect(f.breaker.getState(OAUTH_ALIAS)).toBe("CLOSED");
});

it.each([
  false,
  true,
])("usage limits park accounts and still interleave (stream=%s)", async (stream) => {
  const f = await fixture(stream, {
    error: new UpstreamError("upstream_error", "rate limited", null, 429),
  });
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "key-A", "subscription-B"]);
  expect(f.oauth.getUsageLimit("subscription-A")).toBeGreaterThan(Date.now());
  expect(result.decision.serving_account?.account).toBe("subscription-B");
  if (result.stream)
    for await (const _chunk of result.stream) {
      /* drain */
    }
});

it.each([
  false,
  true,
])("client abort releases pending probes without trying B30 (stream=%s)", async (stream) => {
  const f = await fixture(stream, {
    beforeReply: async (name) => {
      if (name === "key-A") f.controller.abort();
    },
  });
  f.breaker.recordFailure(OAUTH_ALIAS);
  f.advanceClock();
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "key-A"]);
  expect(result.error?.error_class).toBe("client_abort");
  expect(f.breaker.canAttempt(OAUTH_ALIAS)).toMatchObject({ allow: true, probe: true });
  f.breaker.recordAbort(OAUTH_ALIAS);
  expect(f.breaker.getState(KEY_ALIAS)).toBe("CLOSED");
});

it.each([
  false,
  true,
])("native Responses keeps A10 -> K20 -> B30 before output (stream=%s)", async (stream) => {
  const f = await fixture(stream, { native: true });
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "key-A", "subscription-B"]);
  expect(result.final.status).toBe("ok");
  expect(result.decision.serving_account?.account).toBe("subscription-B");
  if (result.stream)
    for await (const _chunk of result.stream) {
      /* drain */
    }
});

it.each([
  false,
  true,
])("a valid output commits the selected account; late faults never replay (native=%s)", async (native) => {
  const f = await fixture(true, { native, success: "key-A", afterOutputFailure: true });
  const result = await f.run();
  expect(result.final.status).toBe("ok");
  await expect(
    (async () => {
      if (result.stream)
        for await (const _chunk of result.stream) {
          /* drain */
        }
    })(),
  ).rejects.toThrow("late failure");
  expect(f.calls).toEqual(["subscription-A", "key-A"]);
  expect(f.breaker.getState(KEY_ALIAS)).toBe("CLOSED");
});

it("suspends attempt and native first-output budgets while a peer runs", async () => {
  vi.useFakeTimers();
  const f = await fixture(true, {
    native: true,
    wallClock: true,
    attemptMs: 50,
    firstOutputMs: 40,
    beforeReply: async (name) => {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, name === "subscription-A" ? 30 : name === "key-A" ? 30 : 1),
      );
    },
  });
  const pending = f.run();
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(f.calls).toEqual(["subscription-A", "key-A", "subscription-B"]);
  expect(result.final.status).toBe("ok");
  expect(f.breaker.getState(OAUTH_ALIAS)).toBe("CLOSED");
  if (result.stream)
    for await (const _chunk of result.stream) {
      /* drain */
    }
  expect(result.decision.latency_total_ms).toBe(61);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a HALF_OPEN probe exclusive while its next sibling is paused", async () => {
  let release = () => {};
  let started = () => {};
  const peerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const peerReply = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(false, {
    success: "key-A",
    beforeReply: async (name) => {
      if (name === "key-A") {
        started();
        await peerReply;
      }
    },
  });
  f.breaker.recordFailure(OAUTH_ALIAS);
  f.advanceClock();
  const pending = f.run();
  try {
    await peerStarted;
    expect(f.breaker.canAttempt(OAUTH_ALIAS)).toMatchObject({ allow: false });
  } finally {
    release();
  }
  const result = await pending;
  expect(result.final.status).toBe("ok");
  expect(f.breaker.canAttempt(OAUTH_ALIAS)).toMatchObject({ allow: true, probe: true });
  f.breaker.recordAbort(OAUTH_ALIAS);
});

it.each([
  "disabled",
  "parked",
  "model",
])("never schedules an ineligible subscription (%s)", async (reason) => {
  const f = await fixture(false, { success: "key-A" });
  if (reason === "disabled") f.oauth.disableAccount("subscription-A");
  else if (reason === "parked") f.oauth.setUsageLimit("subscription-A", Date.now() + 60000);
  else await f.accounts.update(f.keyA.id, { models: ["different-model"] });
  const result = await f.run();
  expect(f.calls).toEqual(reason === "model" ? ["subscription-A", "subscription-B"] : ["key-A"]);
  expect(result.final.status).toBe(reason === "model" ? "error" : "ok");
});

it.each([
  "previous_response_id",
  "turn_state",
  "websocket",
  "account_uuid",
  "persisted_account",
])("bypasses ordering for strict affinity (%s)", async (kind) => {
  const f = await fixture(false, { native: true });
  const base = InternalRequestSchema.parse({
    request_id: "pinned",
    protocol: "openai_responses",
    account_id: "a",
    api_key_id: "k",
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
  });
  if (kind === "persisted_account") base.metadata.stateful_provider_account = "subscription-A";
  else
    base.native_request = createNativePassthroughCarrier({
      protocol: "openai_responses",
      body: {
        model: MODEL,
        input: "hello",
        ...(kind === "previous_response_id" ? { previous_response_id: "resp_fixture" } : {}),
        ...(kind === "account_uuid"
          ? {
              metadata: {
                user_id: JSON.stringify({ account_uuid: "00000000-0000-4000-8000-000000000001" }),
              },
            }
          : {}),
      },
      headers:
        kind === "turn_state"
          ? { "x-codex-turn-state": "fixture-state" }
          : kind === "websocket"
            ? { "x-helm-codex-responses-websocket-session": "fixture-session" }
            : {},
    });
  const snapshot = await f.oauth.accountPriority?.snapshot(MODEL);
  expect(snapshot?.filter((a) => a.eligible)).toHaveLength(2);
  expect(f.oauth.accountPriority?.isPinned(base)).toBe(true);
});

it.each([
  false,
  true,
])("rechecks a parked next tier and resumes a healthy C40 (stream=%s)", async (stream) => {
  const f = await fixture(stream, {
    extraAccount: true,
    success: "subscription-C",
    beforeReply: async (name) => {
      if (name === "key-A") f.oauth.setUsageLimit("subscription-B", Date.now() + 60000);
    },
  });
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "key-A", "subscription-C"]);
  expect(result.final.status).toBe("ok");
  expect(f.breaker.getState(OAUTH_ALIAS)).toBe("CLOSED");
  if (result.stream)
    for await (const _chunk of result.stream) {
      /* drain */
    }
});

it.each(["busy", "credits"])("keeps existing pool eligibility preferences (%s)", async (kind) => {
  const f = await fixture(false, {
    busyA: kind === "busy",
    spendingA: kind === "credits",
    success: "key-A",
  });
  const result = await f.run();
  expect(f.calls).toEqual(["key-A"]);
  expect(result.final.status).toBe("ok");
});

it("scrubs an abandoned pool's pre-output SSE error before retaining it", async () => {
  const marker = "synthetic-credential-marker";
  const f = await fixture(true, { echoedCredential: marker, success: "key-A" });
  const result = await f.run();
  expect(result.final.status).toBe("ok");
  expect(result.decision.provider_attempts[0]?.error_detail).not.toBeNull();
  expect(JSON.stringify(result.decision)).not.toContain(marker);
  expect(JSON.stringify(result.decision)).toContain("[redacted]");
  if (result.stream)
    for await (const _chunk of result.stream) {
      /* drain */
    }
});

it("a preview read failure leaves default routing and credential checks at their existing boundaries", async () => {
  const f = await fixture(false, { success: "subscription-A" });
  for (const member of f.members) member.priority = 50;
  await f.accounts.update(f.keyA.id, { priority: 50 });
  vi.spyOn(f.store, "get").mockRejectedValue(new Error("synthetic store fault"));
  const result = await f.run();
  expect(result.final.status).toBe("ok");
  expect(f.calls).toEqual(["subscription-A"]);
});

it("uses lane order for equal non-default priorities and logs actual account order", async () => {
  const f = await fixture(false, { success: "key-A" });
  for (const member of f.members) member.priority = 20;
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "subscription-B", "key-A"]);
  expect(f.priorityEvents.map((event) => [event.priority, event.sequence])).toEqual([
    [20, 1],
    [20, 2],
    [20, 3],
  ]);
  expect(result.final.status).toBe("ok");
});

it("keeps a known Responses continuation on its original account despite a better key priority", async () => {
  const f = await fixture(false, { native: true, success: "subscription-A" });
  expect((await f.run()).final.status).toBe("ok");
  await f.accounts.update(f.keyA.id, { priority: 1 });
  f.calls.length = 0;
  f.priorityEvents.length = 0;
  const result = await f.run({
    provider_raw: { previous_response_id: "resp_fixture" },
    native_request: createNativePassthroughCarrier({
      protocol: "openai_responses",
      headers: {},
      body: { model: MODEL, previous_response_id: "resp_fixture", input: "continue" },
    }),
  });
  expect(result.final.status).toBe("ok");
  expect(f.calls).toEqual(["subscription-A"]);
  expect(f.priorityEvents).toEqual([]);
  expect(result.decision.serving_account?.account).toBe("subscription-A");
});

it("keeps free-tier 429 as a skip when a peer wins during the pool pause", async () => {
  const f = await fixture(false, {
    free: true,
    success: "key-A",
    error: new UpstreamError("upstream_error", "rate limited", null, 429),
  });
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "key-A"]);
  expect(result.decision.provider_attempts[0]).toMatchObject({
    skipped: true,
    skip_reason: "free_429",
  });
  expect(result.decision.fallback_count).toBe(0);
  expect(f.breaker.getState(f.chain[0])).toBe("CLOSED");
});

it("never restores a provider removed by the key's blocked_models filter", async () => {
  const f = await fixture(false, { success: "key-A", blockedModels: [OAUTH_ALIAS] });
  const result = await f.run();
  expect(f.calls).toEqual(["key-A"]);
  expect(result.decision.lane.candidate_chain).toEqual([KEY_ALIAS]);
  expect(f.priorityEvents).toEqual([]);
});

it("does not expand an explicitly requested single alias into other pools", async () => {
  const f = await fixture(false, { success: "subscription-B", allowCustomModel: true });
  await f.accounts.update(f.keyA.id, { priority: 1 });
  const result = await f.run({ requested_model: OAUTH_ALIAS });
  expect(f.calls).toEqual(["subscription-A", "subscription-B"]);
  expect(result.decision.lane.candidate_chain).toEqual([OAUTH_ALIAS]);
  expect(f.priorityEvents).toEqual([]);
});

it.each([
  false,
  true,
])("round_robin ignores stale non-default account priorities (stream=%s)", async (stream) => {
  const f = await fixture(stream, { keyStrategy: "round_robin" });
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "subscription-B"]);
  expect(f.priorityEvents).toEqual([]);
  expect(result.final.status).toBe("ok");
  if (result.stream)
    for await (const _chunk of result.stream) {
      /* drain */
    }
});

it("does not snapshot either pool when wire model IDs differ", async () => {
  const f = await fixture(false, { keyModel: "other-model", success: "subscription-A" });
  for (const member of f.members) member.priority = 50;
  await f.accounts.update(f.keyA.id, { priority: 50 });
  const get = vi.spyOn(f.store, "get");
  await f.run();
  expect(f.oauthSnapshot).not.toHaveBeenCalled();
  expect(f.keySnapshot).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it.each([
  "oauth",
  "api_key",
])("same-type default chains incur no scheduling reads (%s)", async (kind) => {
  const chain: [string, ...string[]] =
    kind === "oauth"
      ? [OAUTH_ALIAS, "openai-codex/other-model"]
      : [KEY_ALIAS, "openai/other-model"];
  const f = await fixture(false, { chain, success: kind === "oauth" ? "subscription-A" : "key-A" });
  for (const member of f.members) member.priority = 50;
  await f.accounts.update(f.keyA.id, { priority: 50 });
  const get = vi.spyOn(f.store, "get");
  await f.run();
  const chainReads = get.mock.calls.length;
  expect(f.oauthSnapshot).not.toHaveBeenCalled();
  expect(f.keySnapshot).not.toHaveBeenCalled();
  // The same send through a one-alias chain is the baseline for credential validation reads.
  chain.splice(1);
  get.mockClear();
  await f.run();
  expect(chainReads).toBe(get.mock.calls.length);
});

it("takes one scheduling snapshot per pool per request, including a default mixed chain", async () => {
  const f = await fixture(false, { success: "subscription-A" });
  for (const member of f.members) member.priority = 50;
  await f.accounts.update(f.keyA.id, { priority: 50 });
  const get = vi.spyOn(f.store, "get");
  await f.run();
  expect(f.oauthSnapshot).toHaveBeenCalledTimes(1);
  expect(f.keySnapshot).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(1);
  // Each new request gets a fresh snapshot; no cross-request cache.
  await f.run();
  expect(f.oauthSnapshot).toHaveBeenCalledTimes(2);
  expect(f.keySnapshot).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledTimes(2);
});

it("reuses the scheduling snapshot across selections; a transient reread cannot promote K20", async () => {
  const f = await fixture(false, { success: "subscription-A" });
  f.keySnapshot
    .mockImplementationOnce(f.originalKeySnapshot)
    .mockRejectedValue(new Error("synthetic transient read"));
  const get = vi.spyOn(f.store, "get");
  const gate = vi.spyOn(f.breaker, "canAttempt");
  await f.run();
  expect(gate.mock.calls[0]?.[0]).toBe(OAUTH_ALIAS);
  expect(f.calls).toEqual(["subscription-A"]);
  expect(f.keySnapshot).toHaveBeenCalledTimes(1);
  expect(f.oauthSnapshot).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(1);
});

it("A10 -> K20 -> B30 adds only one store read beyond the existing provider validation reads", async () => {
  const f = await fixture(false);
  const get = vi.spyOn(f.store, "get");
  await f.run();
  const sharedReads = get.mock.calls.length;
  expect(f.keySnapshot).toHaveBeenCalledTimes(1);
  expect(f.oauthSnapshot).toHaveBeenCalledTimes(1);
  // A direct K20 call still does the normal refresh/acquire/settle reads.
  f.chain.splice(0, f.chain.length, KEY_ALIAS);
  f.breaker.recordSuccess(KEY_ALIAS);
  get.mockClear();
  await f.run();
  expect(sharedReads).toBe(get.mock.calls.length + 1);
});

it("a round_robin alias keeps its position between otherwise matching pools", async () => {
  const f = await fixture(false, { roundRobinBetween: true, success: "rr-account" });
  const result = await f.run();
  expect(f.calls).toEqual(["subscription-A", "subscription-B", "rr-account"]);
  expect(f.priorityEvents).toEqual([]);
  expect(result.final.status).toBe("ok");
});

it("aliases of the same provider and wire model share the request's snapshot", async () => {
  const f = await fixture(false, {
    chain: [OAUTH_ALIAS, KEY_ALIAS, `${KEY_ALIAS}-mirror`],
    success: "subscription-A",
  });
  for (const member of f.members) member.priority = 50;
  await f.accounts.update(f.keyA.id, { priority: 50 });
  const get = vi.spyOn(f.store, "get");
  await f.run();
  expect(f.oauthSnapshot).toHaveBeenCalledTimes(1);
  expect(f.keySnapshot).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(1);
});

it.each([
  "no-direct",
  "with-direct",
] as const)("retains legacy same-wire priority in nested remainder (%s)", async (nestedLanePriority) => {
  const f = await fixture(false, { nestedLanePriority });
  const result = await f.run();
  expect(result.decision.final.status).toBe("ok");
  expect(f.calls.filter((name) => name !== "direct-failure")).toEqual([
    "subscription-A",
    "key-A",
    "subscription-B",
  ]);
});
