import {
  ApiKeyAccounts,
  type ConfigStore,
  createApiKeyPoolClient,
  createCircuitBreaker,
  createOAuthPoolClient,
  type ProviderClient,
  type ProviderRegistry,
  routeRequest,
  UpstreamError,
} from "@helm/core";
import { InternalRequestSchema, LanesConfigSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createExecute } from "./execute.js";

const MODEL = "gpt-test";
const OAUTH_ALIAS = `openai-codex/${MODEL}`;
const KEY_ALIAS = `openai/${MODEL}`;

async function fixture(stream: boolean, keyFirst: boolean) {
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
  expect(accounts.entries().map((account) => account.priority)).toEqual([50, 50]);

  const client = (name: string): ProviderClient => {
    const call = () => {
      calls.push(name);
      // Reach every sibling and both provider candidates, then succeed.
      if (calls.length < 4) {
        throw new UpstreamError("upstream_error", "synthetic pre-output fault", null, 503);
      }
      return {
        id: "synthetic-result",
        model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    };
    return {
      chatCompletion: async () => call(),
      async *chatCompletionStream() {
        call();
        yield 'data: {"id":"synthetic-result","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n';
        yield "data: [DONE]\n\n";
      },
    };
  };
  const oauth = createOAuthPoolClient({
    members: ["subscription-A", "subscription-B"].map((account) => ({
      account,
      priority: 50,
      schedulable: true,
      models: [MODEL],
      client: client(account),
    })),
  });
  const keys = createApiKeyPoolClient({
    accounts,
    models: [MODEL],
    protocol: "openai_chat",
    createClient: (_key, account) => client(account?.name ?? "unused-template"),
  });
  const registry: ProviderRegistry = {
    list: () => [KEY_ALIAS],
    resolve: (alias) =>
      alias === KEY_ALIAS
        ? {
            ok: true,
            value: {
              alias,
              providerName: "openai",
              providerModel: MODEL,
              baseUrl: "https://example.invalid/v1",
              apiKeyEnv: "UNUSED_SYNTHETIC_KEY",
              targetProviderProtocol: "openai_chat",
              providerRequiresCompatibilityRewrite: false,
            },
          }
        : { ok: false, error: { kind: "unknown_alias", alias } },
  };
  const chain = keyFirst
    ? ([KEY_ALIAS, OAUTH_ALIAS] as const)
    : ([OAUTH_ALIAS, KEY_ALIAS] as const);
  const breaker = createCircuitBreaker({
    config: { failureThreshold: 1, cooldownMs: 1000 },
    now: () => 0,
  });
  const execute = createExecute({
    defaultProvider: keys,
    providers: new Map([
      ["openai", keys],
      ["openai-codex", oauth],
    ]),
    registry,
    knownOAuthPrefixes: new Set(["openai-codex"]),
    oauthAliases: () => new Set([OAUTH_ALIAS]),
    catalog: new Map(),
    breaker,
    now: () => 0,
    signal: new AbortController().signal,
  });
  const run = () =>
    routeRequest(
      InternalRequestSchema.parse({
        request_id: "priority-characterization",
        protocol: "openai_chat",
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
          balanced: { primary: chain[0], fallback: [chain[1]] },
        }),
        execute,
        now: () => new Date(0),
        log: () => {},
      },
    );
  return { calls, run, chain, breaker };
}

describe("account priority at the real routing/execution boundary", () => {
  it.each([
    { stream: false, keyFirst: false },
    { stream: true, keyFirst: false },
    { stream: false, keyFirst: true },
    { stream: true, keyFirst: true },
  ])("default priorities preserve lane and sibling order: %j", async ({ stream, keyFirst }) => {
    const { calls, run, chain, breaker } = await fixture(stream, keyFirst);
    const result = await run();
    if (result.stream) {
      for await (const _chunk of result.stream) {
        // Drain the real gateway stream to complete its breaker/telemetry lifecycle.
      }
    }
    expect(calls).toEqual(
      keyFirst
        ? ["key-A", "key-B", "subscription-A", "subscription-B"]
        : ["subscription-A", "subscription-B", "key-A", "key-B"],
    );
    expect(result.decision.lane.candidate_chain).toEqual(chain);
    expect(result.decision.classifier).toMatchObject({
      decided_by: "fallback",
      fallback_reason: "eval_disabled",
    });
    expect(result.decision.provider_attempts.map((attempt) => attempt.alias)).toEqual(chain);
    expect(result.decision.fallback_count).toBe(1);
    expect(result.decision.final.status).toBe("ok");
    expect(breaker.getState(chain[0])).toBe("OPEN");
    expect(breaker.getState(chain[1])).toBe("CLOSED");
  });
});
