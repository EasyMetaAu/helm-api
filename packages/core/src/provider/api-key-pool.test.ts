import { describe, expect, it } from "vitest";
import type { ConfigStore } from "../store/ports.js";
import { ApiKeyAccounts, createApiKeyPoolClient, nextMonthlyRetry } from "./api-key-pool.js";
import { type ProviderClient, UpstreamError } from "./openai.js";

function memoryStore() {
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
  return { store, data };
}
const KEY = Buffer.alloc(32, 7);
const REQ = { model: "m", messages: [] };
function client(call: () => Promise<Record<string, unknown>>): ProviderClient {
  return {
    chatCompletion: call,
    async *chatCompletionStream() {
      yield `data: ${JSON.stringify(await call())}\n\n`;
    },
  };
}
async function setup(count = 2) {
  const { store, data } = memoryStore();
  let clock = Date.parse("2026-10-29T00:00:00Z");
  const accounts = new ApiKeyAccounts({
    store,
    encKey: KEY,
    poolId: "openai",
    timezone: "Asia/Shanghai",
    now: () => clock,
  });
  await accounts.add(
    Array.from({ length: count }, (_, i) => ({ name: `account-${i}`, key: `sk-proj-test-${i}` })),
  );
  return {
    accounts,
    store,
    data,
    now: () => clock,
    setTime: (value: number) => {
      clock = value;
    },
  };
}

describe("API key accounts and pool", () => {
  it("rotates 100 concurrent stateless requests evenly, even with a soft session key", async () => {
    const s = await setup(5);
    const calls = new Map<string, number>();
    const pool = createApiKeyPoolClient({
      accounts: s.accounts,
      models: ["m"],
      protocol: "openai_chat",
      createClient: (key) =>
        client(async () => {
          calls.set(key, (calls.get(key) ?? 0) + 1);
          return {};
        }),
    });
    await Promise.all(
      Array.from({ length: 100 }, () =>
        pool.chatCompletion({ ...REQ, metadata: { session_id: "same-session" } }),
      ),
    );
    expect([...calls.values()]).toEqual([20, 20, 20, 20, 20]);
    expect(JSON.stringify([...s.data.values()])).not.toContain("sk-proj-test");
    expect(JSON.stringify(await s.accounts.list())).not.toContain("sk-proj-test");
  });

  it("parks a billing failure durably and recovers with one probe across pool instances", async () => {
    const s = await setup();
    let exhausted = true;
    const calls: string[] = [];
    const factory = (key: string) =>
      client(async () => {
        calls.push(key);
        if (key.endsWith("-0") && exhausted)
          throw new UpstreamError(
            "upstream_error",
            "no credits",
            { error: { code: "credit_balance_exhausted" } },
            429,
          );
        return { ok: true };
      });
    const pool = createApiKeyPoolClient({
      accounts: s.accounts,
      models: ["m"],
      protocol: "openai_chat",
      createClient: factory,
    });
    await pool.chatCompletion(REQ);
    await pool.chatCompletion(REQ);
    expect(calls.filter((k) => k.endsWith("-0"))).toHaveLength(1);
    const rows = await s.accounts.list();
    expect(rows[0]).toMatchObject({
      state: "quota_exhausted",
      nextRetryAt: Date.parse("2026-10-31T16:00:00Z"),
    });
    const restarted = new ApiKeyAccounts({
      store: s.store,
      encKey: KEY,
      poolId: "openai",
      timezone: "Asia/Shanghai",
      now: s.now,
    });
    expect((await restarted.list())[0]?.state).toBe("quota_exhausted");
    s.setTime(Date.parse("2026-10-31T16:00:00Z"));
    exhausted = false;
    const id = rows[0]!.id;
    const [a, b] = await Promise.all([s.accounts.acquire(id), restarted.acquire(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ? s.accounts : restarted;
    await winner.settle((a ?? b)!, null);
    expect((await restarted.list())[0]?.state).toBe("ready");
  });

  it("backs off a failed monthly probe for 24h and never revives manual pauses", async () => {
    const s = await setup(1);
    const id = (await s.accounts.list())[0]!.id;
    const error = new UpstreamError(
      "upstream_error",
      "quota",
      { error: { type: "insufficient_quota" } },
      429,
    );
    await s.accounts.settle((await s.accounts.acquire(id))!, error);
    s.setTime(Date.parse("2026-10-31T16:00:00Z"));
    await s.accounts.settle((await s.accounts.acquire(id))!, error);
    expect((await s.accounts.list())[0]?.nextRetryAt).toBe(s.now() + 86_400_000);
    await s.accounts.update(id, { enabled: false });
    await s.accounts.retry(id);
    s.setTime(Date.parse("2026-12-01T00:00:00Z"));
    expect(await s.accounts.acquire(id)).toBeNull();
  });

  it("does not let an old credential result overwrite a replacement", async () => {
    const s = await setup(1);
    const id = (await s.accounts.list())[0]!.id;
    const old = (await s.accounts.acquire(id))!;
    await s.accounts.update(id, { key: "sk-proj-replacement" });
    await s.accounts.settle(
      old,
      new UpstreamError("upstream_error", "invalid", { error: { code: "invalid_api_key" } }, 401),
    );
    expect((await s.accounts.list())[0]?.state).toBe("ready");
  });

  it("does not retry a partial stream or deterministic client error", async () => {
    const s = await setup();
    let calls = 0;
    const pool = createApiKeyPoolClient({
      accounts: s.accounts,
      models: ["m"],
      protocol: "openai_chat",
      createClient: () => ({
        async chatCompletion() {
          calls++;
          throw new UpstreamError(
            "upstream_error",
            "bad body",
            { error: { code: "invalid_request_error" } },
            400,
          );
        },
        async *chatCompletionStream() {
          calls++;
          yield 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
          throw new Error("disconnected");
        },
      }),
    });
    await expect(pool.chatCompletion(REQ)).rejects.toThrow("bad body");
    expect(calls).toBe(1);
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of pool.chatCompletionStream(REQ)) chunks.push(chunk);
      })(),
    ).rejects.toThrow("disconnected");
    expect(chunks).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("rejects a previous response pinned to a replaced credential generation before sending", async () => {
    const s = await setup(1);
    let owner = "";
    const calls: string[] = [];
    const pool = createApiKeyPoolClient({
      accounts: s.accounts,
      models: ["m"],
      protocol: "openai_responses",
      onSelect: (id) => {
        owner = id;
      },
      createClient: (key) => ({
        ...client(async () => ({})),
        nativeProtocolProfile: "generic_openai_responses",
        async nativePassthrough() {
          calls.push(key);
          return { id: "resp_owned_by_old_key" };
        },
      }),
    });
    await pool.nativePassthrough!({ model: "m", input: "first" });
    const oldOwner = owner;
    await s.accounts.update((await s.accounts.list())[0]!.id, { key: "sk-proj-replacement" });
    await expect(
      pool.nativePassthrough!(
        {
          model: "m",
          input: "private continuation",
          previous_response_id: "resp_owned_by_old_key",
        },
        { statefulAccount: oldOwner },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual(["sk-proj-test-0"]);
  });

  it.each([
    new UpstreamError(
      "upstream_error",
      "rate limited",
      { error: { code: "rate_limit_exceeded" } },
      429,
    ),
    new UpstreamError(
      "upstream_error",
      "missing model",
      { error: { code: "model_not_found" } },
      404,
    ),
    new Error("connection failed"),
  ])("backs off an unsuccessful monthly recovery for a day: %s", async (error) => {
    const s = await setup(1);
    const id = (await s.accounts.list())[0]!.id;
    await s.accounts.settle(
      (await s.accounts.acquire(id))!,
      new UpstreamError(
        "upstream_error",
        "credits",
        { error: { code: "credit_balance_exhausted" } },
        429,
      ),
    );
    s.setTime(Date.parse("2026-10-31T16:00:00Z"));
    await s.accounts.settle((await s.accounts.acquire(id))!, error, "m");
    expect((await s.accounts.list())[0]?.nextRetryAt).toBe(s.now() + 86_400_000);
    expect(await s.accounts.acquire(id)).toBeNull();
  });

  it("rechecks model restrictions immediately before sending a selected request", async () => {
    const s = await setup(2);
    const id = (await s.accounts.list())[0]!.id;
    const acquire = s.accounts.acquire.bind(s.accounts);
    let changed = false;
    s.accounts.acquire = async (...args: Parameters<typeof acquire>) => {
      if (!changed) {
        changed = true;
        await s.accounts.update(id, { models: [] });
      }
      return acquire(...args);
    };
    const calls: string[] = [];
    const pool = createApiKeyPoolClient({
      accounts: s.accounts,
      models: ["m"],
      protocol: "openai_chat",
      createClient: (key) =>
        client(async () => {
          calls.push(key);
          return {};
        }),
    });
    await pool.chatCompletion(REQ);
    expect(calls).toEqual(["sk-proj-test-1"]);
  });

  it("uses calendar months and the configured timezone", () => {
    expect(nextMonthlyRetry(Date.parse("2026-12-31T18:00:00Z"), "Asia/Shanghai")).toBe(
      Date.parse("2027-01-31T16:00:00Z"),
    );
    expect(nextMonthlyRetry(Date.parse("2026-10-29T00:00:00Z"), "UTC")).toBe(
      Date.parse("2026-11-01T00:00:00Z"),
    );
  });
});
