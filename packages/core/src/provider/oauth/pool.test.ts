import { beforeEach, describe, expect, it } from "vitest";
import { createRuntimeMemoryCoordinator } from "../../runtime/memory-budget.js";
import { runtimeResponseWorkAdmission } from "../../runtime/response-work-admission.js";
import { preOutputClassifierFor } from "../failover-guard.js";
import {
  type ChatCompletionRequest,
  type ProviderClient,
  type RealtimeCallResult,
  UpstreamError,
} from "../openai.js";
import {
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  createCodexResponsesClient,
} from "../openai-responses.js";
import { TokenRefreshError } from "../token-manager.js";
import { createOAuthPoolClient, type OAuthPoolMember } from "./pool.js";

beforeEach(() => {
  runtimeResponseWorkAdmission(
    createRuntimeMemoryCoordinator({ capacityBytes: () => Number.MAX_SAFE_INTEGER }),
  );
});

// A stub account client that records every call it served (so a test can assert
// which account the pool routed to). Returns a body tagged with the account.
function stubClient(account: string, calls: string[]): ProviderClient {
  return {
    async chatCompletion(_req: ChatCompletionRequest) {
      calls.push(account);
      return { served_by: account };
    },
    async *chatCompletionStream(_req: ChatCompletionRequest) {
      calls.push(account);
      yield `data: ${account}\n\n`;
    },
  };
}

function member(
  account: string,
  priority: number,
  schedulable: boolean,
  calls: string[],
): OAuthPoolMember {
  return { account, priority, schedulable, client: stubClient(account, calls) };
}

const REQ: ChatCompletionRequest = { model: "m", messages: [] };
const USER_REQ: ChatCompletionRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
};

describe("createOAuthPoolClient — Realtime account binding", () => {
  it("returns the sideband target from the account that created each call", async () => {
    const served: string[] = [];
    const realtimeClient = (account: string): ProviderClient => ({
      ...stubClient(account, served),
      async realtimeCall(_req): Promise<RealtimeCallResult> {
        served.push(account);
        return {
          status: 201,
          sdp: `answer-${account}`,
          contentType: "application/sdp",
          location: `/v1/realtime/calls/rtc_${account}`,
          callId: `rtc_${account}`,
          sideband: {
            url: `wss://${account}.test/v1/realtime?call_id=rtc_${account}`,
            headers: async () => ({ Authorization: `Bearer ${account}` }),
          },
        };
      },
    });
    const pool = createOAuthPoolClient({
      members: [
        { account: "a", priority: 10, schedulable: true, client: realtimeClient("a") },
        { account: "b", priority: 10, schedulable: true, client: realtimeClient("b") },
      ],
      now: () => 1,
    });
    const request = {
      endpoint: "realtime" as const,
      query: "",
      sdp: "offer",
      session: { model: "gpt-realtime-1.5" },
      headers: {},
    };

    const first = await pool.realtimeCall?.(request);
    const second = await pool.realtimeCall?.(request);

    expect(served).toEqual(["a", "b"]);
    expect(first?.sideband.url).toContain("a.test");
    expect(await first?.sideband.headers()).toEqual({ Authorization: "Bearer a" });
    expect(second?.sideband.url).toContain("b.test");
  });

  it("does not disable a text-capable account when Realtime voice access is denied", async () => {
    const denied = new UpstreamError("upstream_error", "Voice session access denied.", null, 403);
    const credentialFailures: string[] = [];
    const calls: string[] = [];
    const client = (account: string, allowed: boolean): ProviderClient => ({
      ...stubClient(account, calls),
      async realtimeCall() {
        calls.push(account);
        if (!allowed) throw denied;
        return {
          status: 201,
          sdp: `answer-${account}`,
          contentType: "application/sdp",
          location: `/v1/realtime/calls/rtc_${account}`,
          callId: `rtc_${account}`,
          sideband: {
            url: `wss://${account}.test/v1/realtime?call_id=rtc_${account}`,
            headers: async () => ({ Authorization: `Bearer ${account}` }),
          },
        };
      },
    });
    const pool = createOAuthPoolClient({
      members: [
        { account: "a", priority: 10, schedulable: true, client: client("a", false) },
        { account: "b", priority: 10, schedulable: true, client: client("b", true) },
      ],
      now: () => 1,
      onAccountCredentialFailure: (account) => credentialFailures.push(account),
    });

    await expect(
      pool.realtimeCall?.({
        endpoint: "realtime",
        query: "",
        sdp: "offer",
        session: { model: "gpt-realtime-1.5" },
        headers: {},
      }),
    ).resolves.toMatchObject({ callId: "rtc_b" });

    expect(calls).toEqual(["a", "b"]);
    expect(credentialFailures).toEqual([]);
  });

  it("parks the selected account when sideband token refresh permanently fails", async () => {
    const credentialFailures: string[] = [];
    const refreshFailure = new TokenRefreshError("oauth refresh failed (status 401)", 401, true);
    const client = (account: string): ProviderClient => ({
      ...stubClient(account, []),
      async realtimeCall() {
        return {
          status: 201,
          sdp: "answer",
          contentType: "application/sdp",
          location: `/v1/realtime/calls/rtc_${account}`,
          callId: `rtc_${account}`,
          sideband: {
            url: `wss://${account}.test/v1/realtime?call_id=rtc_${account}`,
            headers: async () => {
              throw refreshFailure;
            },
          },
        };
      },
    });
    const pool = createOAuthPoolClient({
      members: [
        { account: "a", priority: 10, schedulable: true, client: client("a") },
        { account: "b", priority: 10, schedulable: true, client: client("b") },
      ],
      onAccountCredentialFailure: (account) => credentialFailures.push(account),
    });

    const result = await pool.realtimeCall?.({
      endpoint: "realtime",
      query: "",
      sdp: "offer",
      session: { model: "gpt-realtime-1.5" },
      headers: {},
    });
    await expect(result?.sideband.headers()).rejects.toBe(refreshFailure);

    expect(credentialFailures).toEqual(["a"]);
  });
});

describe("createOAuthPoolClient — account selection", () => {
  it("exposes a shared native protocol profile from homogeneous members", () => {
    const calls: string[] = [];
    const profileClient = (account: string): ProviderClient => ({
      ...stubClient(account, calls),
      nativeProtocolProfile: "generic_openai_responses",
    });
    const pool = createOAuthPoolClient({
      members: [
        { account: "a", priority: 10, schedulable: true, client: profileClient("a") },
        { account: "b", priority: 20, schedulable: true, client: profileClient("b") },
      ],
    });

    expect(pool.nativeProtocolProfile).toBe("generic_openai_responses");
  });

  it("prefers the lowest priority (lower = preferred)", async () => {
    const calls: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 10, true, calls)],
      onSelect: (acc) => selected.push(acc),
    });
    const res = await pool.chatCompletion(REQ);
    expect(res).toEqual({ served_by: "b" });
    expect(calls).toEqual(["b"]);
    expect(selected).toEqual(["b"]);
  });

  it("round-robins (LRU) within an equal priority", async () => {
    const calls: string[] = [];
    let clock = 1000;
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
      now: () => clock++,
    });
    // Both start at lastUsedAt 0 → first-seen (a) wins the tie; then b is older.
    await pool.chatCompletion(REQ);
    await pool.chatCompletion(REQ);
    await pool.chatCompletion(REQ);
    await pool.chatCompletion(REQ);
    expect(calls).toEqual(["a", "b", "a", "b"]);
  });

  it("low_risk strategy prefers the account with the lowest applicable quota pressure", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          ...member("nearly-full", 50, true, calls),
          quotaWindows: [{ key: "5h", usedPercent: 91, resetsAtMs: 20_000, windowMinutes: 300 }],
          quotaCapturedAtMs: 1_000,
        },
        {
          ...member("cooler", 50, true, calls),
          quotaWindows: [{ key: "5h", usedPercent: 42, resetsAtMs: 20_000, windowMinutes: 300 }],
          quotaCapturedAtMs: 1_000,
        },
      ],
      selectionStrategy: "low_risk",
      now: () => 2_000,
    });

    await pool.chatCompletion(REQ);

    expect(calls).toEqual(["cooler"]);
  });

  it("quota strategies score only the preferred priority tier", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          ...member("preferred-but-hot", 10, true, calls),
          quotaWindows: [{ key: "5h", usedPercent: 91, resetsAtMs: 20_000, windowMinutes: 300 }],
          quotaCapturedAtMs: 1_000,
        },
        {
          ...member("backup-and-cool", 50, true, calls),
          quotaWindows: [{ key: "5h", usedPercent: 5, resetsAtMs: 20_000, windowMinutes: 300 }],
          quotaCapturedAtMs: 1_000,
        },
      ],
      selectionStrategy: "low_risk",
      now: () => 2_000,
    });

    await pool.chatCompletion(REQ);

    expect(calls).toEqual(["preferred-but-hot"]);
  });

  it("low_risk strategy applies Anthropic scoped weekly windows only to matching models", async () => {
    const calls: string[] = [];
    const mkScopedPool = () =>
      createOAuthPoolClient({
        members: [
          {
            ...member("opus-cool", 50, true, calls),
            quotaWindows: [
              { key: "7d-opus", usedPercent: 10, resetsAtMs: 20_000, windowMinutes: null },
              { key: "7d-sonnet", usedPercent: 90, resetsAtMs: 20_000, windowMinutes: null },
            ],
            quotaCapturedAtMs: 1_000,
          },
          {
            ...member("sonnet-cool", 50, true, calls),
            quotaWindows: [
              { key: "7d-opus", usedPercent: 90, resetsAtMs: 20_000, windowMinutes: null },
              { key: "7d-sonnet", usedPercent: 10, resetsAtMs: 20_000, windowMinutes: null },
            ],
            quotaCapturedAtMs: 1_000,
          },
        ],
        selectionStrategy: "low_risk",
        now: () => 2_000,
      });

    await mkScopedPool().chatCompletion({ ...REQ, model: "claude-sonnet-4-6" });
    await mkScopedPool().chatCompletion({ ...REQ, model: "claude-opus-4-8" });

    expect(calls).toEqual(["sonnet-cool", "opus-cool"]);
  });

  it("use_expiring strategy spends quota that is both available and close to reset", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          ...member("far", 50, true, calls),
          quotaWindows: [
            { key: "5h", usedPercent: 20, resetsAtMs: 11 * 60 * 60 * 1000, windowMinutes: 300 },
          ],
          quotaCapturedAtMs: 1_000,
        },
        {
          ...member("soon", 50, true, calls),
          quotaWindows: [
            { key: "5h", usedPercent: 40, resetsAtMs: 30 * 60 * 1000, windowMinutes: 300 },
          ],
          quotaCapturedAtMs: 1_000,
        },
      ],
      selectionStrategy: "use_expiring",
      now: () => 1_000,
    });

    await pool.chatCompletion(REQ);

    expect(calls).toEqual(["soon"]);
  });

  it("use_expiring strategy combines short and weekly windows instead of only taking the best single window", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          ...member("weekly-left", 50, true, calls),
          quotaWindows: [
            { key: "primary", usedPercent: 60, resetsAtMs: 60 * 60 * 1000, windowMinutes: 300 },
            {
              key: "secondary",
              usedPercent: 60,
              resetsAtMs: 60 * 60 * 1000,
              windowMinutes: 10_080,
            },
          ],
          quotaCapturedAtMs: 1_000,
        },
        {
          ...member("short-left", 50, true, calls),
          quotaWindows: [
            { key: "primary", usedPercent: 10, resetsAtMs: 60 * 60 * 1000, windowMinutes: 300 },
            {
              key: "secondary",
              usedPercent: 100,
              resetsAtMs: 60 * 60 * 1000,
              windowMinutes: 10_080,
            },
          ],
          quotaCapturedAtMs: 1_000,
        },
      ],
      selectionStrategy: "use_expiring",
      now: () => 1_000,
    });

    await pool.chatCompletion(REQ);

    expect(calls).toEqual(["weekly-left"]);
  });

  it("use_expiring strategy includes Codex reset credits as recoverable weekly capacity", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          ...member("no-credits", 50, true, calls),
          quotaWindows: [
            { key: "primary", usedPercent: 10, resetsAtMs: 60 * 60 * 1000, windowMinutes: 300 },
          ],
          quotaCapturedAtMs: 1_000,
          quotaResetCredits: 0,
        },
        {
          ...member("has-credits", 50, true, calls),
          quotaWindows: [
            { key: "primary", usedPercent: 10, resetsAtMs: 60 * 60 * 1000, windowMinutes: 300 },
          ],
          quotaCapturedAtMs: 1_000,
          quotaResetCredits: 2,
        },
      ],
      selectionStrategy: "use_expiring",
      now: () => 1_000,
    });

    await pool.chatCompletion(REQ);

    expect(calls).toEqual(["has-credits"]);
  });

  it("use_expiring does not let reset credits outweigh substantially more expiring weekly quota", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          ...member("plus-with-more-expiring-quota", 50, true, calls),
          quotaWindows: [
            {
              key: "primary",
              usedPercent: 2,
              resetsAtMs: 7 * 24 * 60 * 60 * 1000,
              windowMinutes: 10_080,
            },
          ],
          quotaCapturedAtMs: 1_000,
          quotaResetCredits: 0,
        },
        {
          ...member("pro-with-reset-credits", 50, true, calls),
          quotaWindows: [
            {
              key: "primary",
              usedPercent: 31,
              resetsAtMs: 7 * 24 * 60 * 60 * 1000,
              windowMinutes: 10_080,
            },
          ],
          quotaCapturedAtMs: 1_000,
          quotaResetCredits: 3,
        },
      ],
      selectionStrategy: "use_expiring",
      now: () => 1_000,
    });

    await pool.chatCompletion(REQ);

    expect(calls).toEqual(["plus-with-more-expiring-quota"]);
  });

  it("manual_priority keeps new sessions on priority/LRU instead of hash assignment", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
      selectionStrategy: "manual_priority",
    });

    await pool.chatCompletion({ ...USER_REQ, prompt_cache_key: "thread-a" });
    await pool.chatCompletion({ ...USER_REQ, prompt_cache_key: "thread-a" });

    // thread-a hashes to b in balanced mode, but manual_priority lets the first LRU
    // account own the session, then sticky keeps later turns there.
    expect(calls).toEqual(["a", "a"]);
  });

  it("quota strategies fall back to balanced selection when every quota snapshot is stale", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          ...member("a", 50, true, calls),
          quotaWindows: [{ key: "5h", usedPercent: 99, resetsAtMs: 20_000, windowMinutes: 300 }],
          quotaCapturedAtMs: 1_000,
        },
        {
          ...member("b", 50, true, calls),
          quotaWindows: [{ key: "5h", usedPercent: 1, resetsAtMs: 20_000, windowMinutes: 300 }],
          quotaCapturedAtMs: 1_000,
        },
      ],
      selectionStrategy: "low_risk",
      quotaFreshMs: 500,
      now: () => 2_000,
    });

    await pool.chatCompletion(REQ);

    expect(calls).toEqual(["a"]);
  });

  it("keeps a chat prompt_cache_key on one deterministic account", async () => {
    const calls: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
      onSelect: (acc) => selected.push(acc),
    });

    const req = { ...USER_REQ, prompt_cache_key: "thread-a" };
    await pool.chatCompletion(req);
    await pool.chatCompletion(req);
    await pool.chatCompletion(req);

    // thread-a hashes to b; repeated turns do not LRU-rotate across accounts.
    expect(calls).toEqual(["b", "b", "b"]);
    expect(selected).toEqual(["b", "b", "b"]);
  });

  it("bounds one-off sticky session keys and evicts the least-recently-used entry", async () => {
    const calls: string[] = [];
    const reasons: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
      maxStickySessions: 2,
      onSelect: (_account, selection) => reasons.push(selection.reason),
    });

    for (const key of ["one", "two", "three"]) {
      await pool.chatCompletion({ ...USER_REQ, prompt_cache_key: key });
    }
    await pool.chatCompletion({ ...USER_REQ, prompt_cache_key: "one" });

    // The fourth selection cannot be a sticky hit: `one` was the oldest of
    // three distinct untrusted keys in a two-entry cache.
    expect(reasons.at(-1)).toBe("hash_assign");
  });

  it("uses chat metadata conversation_id as a sticky account key for streams", async () => {
    const calls: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
      onSelect: (acc) => selected.push(acc),
    });
    const req = { ...USER_REQ, metadata: { conversation_id: "conv-b" } };

    for await (const _ of pool.chatCompletionStream(req)) {
      /* drain first stream */
    }
    for await (const _ of pool.chatCompletionStream(req)) {
      /* drain second stream */
    }

    // conv-b hashes to a; streaming now follows the same affinity rule as non-stream.
    expect(calls).toEqual(["a", "a"]);
    expect(selected).toEqual(["a", "a"]);
  });

  it("rejects a translated continuation when its persisted account is unavailable", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("a", 50, true, calls), schedulable: false },
        member("b", 50, true, calls),
      ],
    });

    expect(() =>
      pool.chatCompletionStream(
        { ...USER_REQ, previous_response_id: "resp-a" },
        { statefulAccount: "a" },
      ),
    ).toThrow("previous_response_id original account is unavailable");
    expect(calls).toEqual([]);
  });

  it("spreads distinct sticky sessions across equal-priority accounts", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
    });

    await pool.chatCompletion({ ...USER_REQ, metadata: { conversation_id: "conv-b" } });
    await pool.chatCompletion({ ...USER_REQ, prompt_cache_key: "thread-a" });

    expect(calls).toEqual(["a", "b"]);
  });

  it("keeps new sticky-session distribution reasonably balanced across equal-priority accounts", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        member("a", 50, true, calls),
        member("b", 50, true, calls),
        member("c", 50, true, calls),
      ],
    });

    for (let i = 0; i < 300; i += 1) {
      await pool.chatCompletion({ ...USER_REQ, prompt_cache_key: `session-${i}` });
    }

    const counts = new Map<string, number>();
    for (const account of calls) counts.set(account, (counts.get(account) ?? 0) + 1);
    expect(counts.size).toBe(3);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(70);
      expect(count).toBeLessThan(130);
    }
  });

  it("prefers a stable metadata.user_id device id over changing chat session signals", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
    });
    const userId = (session: string) =>
      JSON.stringify({ device_id: "device-stable-1", account_uuid: "", session_id: session });

    await pool.chatCompletion({
      ...USER_REQ,
      prompt_cache_key: "thread-a",
      metadata: { user_id: userId("session-1") },
    });
    await pool.chatCompletion({
      ...USER_REQ,
      metadata: { conversation_id: "conv-b", user_id: userId("session-2") },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
  });

  it("uses an explicit metadata device_id as chat account affinity", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
    });

    await pool.chatCompletion({
      ...USER_REQ,
      prompt_cache_key: "thread-a",
      metadata: { device_id: "device-explicit-1" },
    });
    await pool.chatCompletion({
      ...USER_REQ,
      metadata: { conversation_id: "conv-b", device_id: "device-explicit-1" },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
  });

  it("maps a known previous_response_id back to the account that produced it", async () => {
    const calls: string[] = [];
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          calls.push(account);
          return { id: `resp-${account}`, served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          calls.push(account);
          yield `data: ${account}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
      now: () => 1_000,
    });

    await pool.chatCompletion(REQ);
    await pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-a" });

    expect(calls).toEqual(["a", "a"]);
  });

  it("keeps previous_response_id affinity even when a quota strategy prefers another account", async () => {
    const calls: string[] = [];
    let clock = 1_000;
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          calls.push(account);
          return { id: `resp-${account}`, served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          calls.push(account);
          yield `data: ${account}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
      selectionStrategy: "low_risk",
      now: () => clock,
    });

    await pool.chatCompletion(REQ);
    pool.setQuotaSnapshot(
      "a",
      [{ key: "5h", usedPercent: 90, resetsAtMs: 20_000, windowMinutes: 300 }],
      clock,
    );
    pool.setQuotaSnapshot(
      "b",
      [{ key: "5h", usedPercent: 10, resetsAtMs: 20_000, windowMinutes: 300 }],
      clock,
    );
    clock = 2_000;
    await pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-a" });

    expect(calls).toEqual(["a", "a"]);
  });

  it("rejects when a known previous_response_id original account is unavailable", async () => {
    const calls: string[] = [];
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          calls.push(account);
          return { id: `resp-${account}`, served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          calls.push(account);
          yield `data: ${account}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
      now: () => 1_000,
    });

    await pool.chatCompletion(REQ);
    pool.setUsageLimit("a", 50_000);

    await expect(
      pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-a" }),
    ).rejects.toThrow("previous_response_id original account is unavailable");
    expect(calls).toEqual(["a"]);
  });

  it("never retries a known previous_response_id on a sibling after a transient fault", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          account: "a",
          priority: 50,
          schedulable: true,
          client: {
            async chatCompletion(req: ChatCompletionRequest) {
              calls.push("a");
              if (req.previous_response_id) {
                throw new UpstreamError("upstream_error", "temporary", null, null);
              }
              return { id: "resp-a" };
            },
            async *chatCompletionStream() {
              yield "data: a\n\n";
            },
          },
        },
        member("b", 50, true, calls),
      ],
    });

    await pool.chatCompletion(REQ);
    await expect(
      pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-a" }),
    ).rejects.toThrow("temporary");
    expect(calls).toEqual(["a", "a"]);
  });

  it("rejects an unknown previous_response_id without calling any account", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
    });

    await expect(
      pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-1" }),
    ).rejects.toThrow("previous_response_id original account is unavailable");
    expect(calls).toEqual([]);
  });

  it("restores a persisted previous_response_id account pin after pool restart", async () => {
    const calls: string[] = [];
    const nativeMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        ...stubClient(account, calls),
        async nativePassthrough() {
          calls.push(account);
          return { id: `resp-${account}` };
        },
      },
    });
    const pool = createOAuthPoolClient({ members: [nativeMember("a"), nativeMember("b")] });

    await pool.nativePassthrough?.(
      {
        protocol: "openai_responses",
        body: { model: "gpt", input: [], previous_response_id: "resp-old" },
        headers: {},
        mutations: {},
      },
      { statefulAccount: "b" },
    );

    expect(calls).toEqual(["b"]);
  });

  it("keeps a known previous_response_id on its original account even with a stable user key", async () => {
    const calls: string[] = [];
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          calls.push(account);
          return { id: `resp-${account}`, served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          calls.push(account);
          yield `data: ${account}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
      now: () => 1_000,
    });

    await pool.chatCompletion(REQ);
    await pool.chatCompletion({
      ...USER_REQ,
      user: "stable-user",
      previous_response_id: "resp-a",
    });

    expect(calls).toEqual(["a", "a"]);
  });

  it("keeps sticky hashing inside the lowest-priority eligible tier", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 10, true, calls), member("b", 50, true, calls)],
    });

    await pool.chatCompletion({ ...USER_REQ, prompt_cache_key: "thread-a" });

    // thread-a hashes to b when both accounts are equal priority, but b is a lower
    // preference tier here. Priority still wins before affinity distribution.
    expect(calls).toEqual(["a"]);
  });

  it("uses a lower-priority account when the whole preferred tier is at capacity", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("a", 10, true, calls), isAtCapacity: () => true },
        member("b", 50, true, calls),
      ],
    });

    await pool.chatCompletion({ ...USER_REQ, metadata: { conversation_id: "conv-b" } });

    // conv-b normally maps to preferred account a, but a would queue and b is open.
    expect(calls).toEqual(["b"]);
  });

  it("prefers another account when the sticky target is at capacity", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("a", 50, true, calls), isAtCapacity: () => true },
        member("b", 50, true, calls),
      ],
    });

    await pool.chatCompletion({ ...USER_REQ, metadata: { conversation_id: "conv-b" } });

    // conv-b normally hashes to a, but a would queue, so the request moves to b.
    expect(calls).toEqual(["b"]);
  });

  it("prefers another account when a chat stream sticky target is at capacity", async () => {
    const calls: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("a", 50, true, calls), isAtCapacity: () => true },
        member("b", 50, true, calls),
      ],
      onSelect: (acc) => selected.push(acc),
    });

    const chunks: string[] = [];
    for await (const c of pool.chatCompletionStream({
      ...USER_REQ,
      metadata: { conversation_id: "conv-b" },
    })) {
      chunks.push(c);
    }

    expect(calls).toEqual(["b"]);
    expect(selected).toEqual(["b"]);
    expect(chunks).toEqual(["data: b\n\n"]);
  });

  it("queues on the sticky account when every eligible account is at capacity", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("a", 50, true, calls), isAtCapacity: () => true },
        { ...member("b", 50, true, calls), isAtCapacity: () => true },
      ],
    });

    await pool.chatCompletion({ ...USER_REQ, metadata: { conversation_id: "conv-b" } });

    // All accounts are busy, so selection falls back to the deterministic target.
    expect(calls).toEqual(["a"]);
  });

  it("skips an unschedulable account entirely", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("parked", 1, false, calls), member("live", 90, true, calls)],
    });
    await pool.chatCompletion(REQ);
    await pool.chatCompletion(REQ);
    expect(calls).toEqual(["live", "live"]);
  });

  it("routes Sol and Luna only to accounts whose model allowlists include them", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("sol-only", 50, true, calls), models: ["gpt-5.6-sol"] },
        { ...member("luna-only", 10, true, calls), models: ["gpt-5.6-luna"] },
      ],
    });

    await pool.chatCompletion({ ...REQ, model: "gpt-5.6-sol" });
    await pool.chatCompletion({ ...REQ, model: "gpt-5.6-luna" });

    expect(calls).toEqual(["sol-only", "luna-only"]);
  });

  it("invalidates a sticky account when the next request uses a model it does not support", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("sol-only", 10, true, calls), models: ["gpt-5.6-sol"] },
        { ...member("luna-only", 50, true, calls), models: ["gpt-5.6-luna"] },
      ],
    });
    const sticky = { ...USER_REQ, prompt_cache_key: "cross-model-session" };

    await pool.chatCompletion({ ...sticky, model: "gpt-5.6-sol" });
    await pool.chatCompletion({ ...sticky, model: "gpt-5.6-luna" });

    expect(calls).toEqual(["sol-only", "luna-only"]);
  });

  it("fails explicitly when no account supports the requested model", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("sol-only", 10, true, calls), models: ["gpt-5.6-sol"] },
        { ...member("luna-only", 50, true, calls), models: ["gpt-5.6-luna"] },
      ],
    });

    await expect(pool.chatCompletion({ ...REQ, model: "gpt-5.6-terra" })).rejects.toThrow(
      'no account supports model "gpt-5.6-terra"',
    );
    expect(calls).toEqual([]);
  });

  it("throws fail-closed when no member is schedulable", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, false, calls), member("b", 10, false, calls)],
    });
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/no schedulable account/);
  });

  it("skips an account whose usage-limit cooldown is still in the future", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("limited", 1, true, calls), usageLimitedUntilMs: 5_000 },
        member("live", 90, true, calls),
      ],
      now: () => 1_000,
    });
    await pool.chatCompletion(REQ);
    await pool.chatCompletion(REQ);
    // The preferred (priority 1) account is parked by its cooldown; only "live" serves.
    expect(calls).toEqual(["live", "live"]);
  });

  it("auto-recovers an account once its cooldown passes (no manual action)", async () => {
    const calls: string[] = [];
    let clock = 1_000;
    const pool = createOAuthPoolClient({
      members: [{ ...member("a", 1, true, calls), usageLimitedUntilMs: 5_000 }],
      now: () => clock,
    });
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/no schedulable account/);
    clock = 5_000; // reset reached → eligible again with zero intervention
    await pool.chatCompletion(REQ);
    expect(calls).toEqual(["a"]);
  });

  it("throws fail-closed when every account is usage-limited", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...member("a", 1, true, calls), usageLimitedUntilMs: 9_000 },
        { ...member("b", 2, true, calls), usageLimitedUntilMs: 9_000 },
      ],
      now: () => 1_000,
    });
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/no schedulable account/);
  });

  it("allowSpendRemainingCredits keeps a usage-limited member eligible (operator opt-in)", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      // "a" is parked far in the future but opted in to spend its remaining credits;
      // it must stay selectable instead of falling through to the un-parked sibling.
      members: [
        {
          ...member("a", 1, true, calls),
          usageLimitedUntilMs: 9_000,
          allowSpendRemainingCredits: true,
        },
        { ...member("b", 2, true, calls), usageLimitedUntilMs: 9_000 },
      ],
      now: () => 1_000,
    });
    await pool.chatCompletion(REQ);
    expect(calls).toEqual(["a"]);
  });

  it("sinks a limited-but-spending account below a healthy sibling (all strategies)", async () => {
    // "a": rate-limited but opted in to spend remaining credits (real money).
    // "b": healthy subscription account. Even though "a" has BETTER priority and is
    // less-recently-used, the pool must prefer "b" — burning credits is the last
    // resort. Assert across every strategy so it never depends on use_expiring luck.
    for (const strategy of ["balanced", "manual_priority", "low_risk", "use_expiring"] as const) {
      const calls: string[] = [];
      const pool = createOAuthPoolClient({
        members: [
          {
            ...member("a", 1, true, calls), // better priority
            usageLimitedUntilMs: 9_000,
            allowSpendRemainingCredits: true,
          },
          { ...member("b", 2, true, calls) }, // healthy, worse priority
        ],
        selectionStrategy: strategy,
        now: () => 1_000,
      });
      await pool.chatCompletion(REQ);
      expect(calls, `strategy=${strategy}`).toEqual(["b"]);
    }
  });

  it("falls back to the limited-but-spending account when no healthy account is left", async () => {
    // Only the spending account is eligible (sibling is hard-limited, no opt-in) →
    // the sink tier must still yield it rather than fail closed.
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        {
          ...member("a", 1, true, calls),
          usageLimitedUntilMs: 9_000,
          allowSpendRemainingCredits: true,
        },
        { ...member("b", 2, true, calls), usageLimitedUntilMs: 9_000 },
      ],
      now: () => 1_000,
    });
    await pool.chatCompletion(REQ);
    expect(calls).toEqual(["a"]);
  });

  it("a stateful previous_response_id continuation still pins to its limited-but-spending account", async () => {
    // Correctness > waste-avoidance: a previous_response_id pinned to the spending
    // account must NOT be diverted to a healthy sibling mid-conversation.
    const calls: string[] = [];
    let clock = 1_000;
    const responseMember = (account: string, spend = false): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      ...(spend ? { allowSpendRemainingCredits: true } : {}),
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          calls.push(account);
          return { id: `resp-${account}`, served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          calls.push(account);
          yield `data: ${account}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      // "a" opted in to spend remaining credits; "b" is a healthy sibling.
      members: [responseMember("a", true), responseMember("b")],
      now: () => clock,
    });
    await pool.chatCompletion(REQ); // → a; seeds resp-a → a affinity
    pool.setUsageLimit("a", 50_000); // a hits its limit but keeps spending → would be sunk
    clock = 2_000;
    await pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-a" });
    expect(calls).toEqual(["a", "a"]); // pinned to a, NOT diverted to healthy b
  });

  it("setUsageLimit parks a live member; null un-parks it (the reset path)", async () => {
    const calls: string[] = [];
    let clock = 1_000;
    const pool = createOAuthPoolClient({
      members: [member("a", 1, true, calls), member("b", 2, true, calls)],
      now: () => clock,
    });
    pool.setUsageLimit("a", 5_000); // park the preferred account
    await pool.chatCompletion(REQ); // → falls to b
    pool.setUsageLimit("a", null); // reset usage → a eligible again
    clock = 1_001;
    await pool.chatCompletion(REQ); // a is preferred (priority 1)
    expect(calls).toEqual(["b", "a"]);
  });

  it("setUsageLimit on an unknown account is a no-op", () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({ members: [member("a", 1, true, calls)] });
    expect(() => pool.setUsageLimit("nope", 5_000)).not.toThrow();
  });

  it("does not pin a sticky session to a now-limited account", async () => {
    const pt: string[] = [];
    const clock = 1_000;
    const mkPt = (account: string, priority: number): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          return { served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          yield `data: ${account}\n\n`;
        },
        nativePassthrough: async (body: Record<string, unknown>) => {
          pt.push(account);
          return { served_by: account, body };
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [mkPt("a", 1), mkPt("b", 2)],
      now: () => clock,
      stickyTtlMs: 10_000,
    });
    const session = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5-codex", input: "hi" },
      headers: { session_id: "s1" },
      mutations: {},
    };
    await pool.nativePassthrough?.(session); // → a (preferred), session sticks to a
    pool.setUsageLimit("a", 50_000); // a hits its limit mid-session
    await pool.nativePassthrough?.(session); // sticky would pick a, but it's parked → b
    expect(pt).toEqual(["a", "b"]);
  });

  it("selects per stream call too (rotation + onSelect fire for streaming)", async () => {
    const calls: string[] = [];
    const selected: string[] = [];
    let clock = 1;
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
      now: () => clock++,
      onSelect: (acc) => selected.push(acc),
    });
    for await (const _ of pool.chatCompletionStream(REQ)) {
      /* drain first stream */
    }
    for await (const _ of pool.chatCompletionStream(REQ)) {
      /* drain second stream */
    }
    expect(calls).toEqual(["a", "b"]);
    expect(selected).toEqual(["a", "b"]);
  });
});

// Native protocol passthrough (issue #217, Phase 1): a subscription alias is fronted by
// the pool, so unless the pool FORWARDS nativePassthrough the executor's feature-detect
// (`provider.nativePassthrough`) is forever undefined and the branch never fires. The
// pool must select() synchronously (rotation + onSelect) then delegate to the picked
// member's nativePassthrough — and fail-closed if the picked member lacks it (never
// silently falls back to a translating sibling).
describe("createOAuthPoolClient — nativePassthrough", () => {
  function ptMember(
    account: string,
    priority: number,
    ptCalls: string[],
    opts?: { withPassthrough?: boolean },
  ): OAuthPoolMember {
    const base: ProviderClient = {
      async chatCompletion(_req: ChatCompletionRequest) {
        return { served_by: account };
      },
      async *chatCompletionStream(_req: ChatCompletionRequest) {
        yield `data: ${account}\n\n`;
      },
    };
    if (opts?.withPassthrough !== false) {
      base.nativePassthrough = async (body: Record<string, unknown>) => {
        ptCalls.push(account);
        return { served_by: account, body };
      };
    }
    return { account, priority, schedulable: true, client: base };
  }

  const NATIVE: Record<string, unknown> = { model: "claude-x", messages: [] };

  it("selects + rotates + fires onSelect + delegates to the member's nativePassthrough", async () => {
    const pt: string[] = [];
    const selected: string[] = [];
    let clock = 1;
    const pool = createOAuthPoolClient({
      members: [ptMember("a", 50, pt), ptMember("b", 50, pt)],
      now: () => clock++,
      onSelect: (acc) => selected.push(acc),
    });
    const r1 = await pool.nativePassthrough?.(NATIVE);
    const r2 = await pool.nativePassthrough?.(NATIVE);
    // Round-robins like the other methods; onSelect fired with the picked account.
    expect(pt).toEqual(["a", "b"]);
    expect(selected).toEqual(["a", "b"]);
    // Delegated verbatim — body forwarded, response carries the serving account.
    expect(r1).toEqual({ served_by: "a", body: NATIVE });
    expect(r2).toEqual({ served_by: "b", body: NATIVE });
  });

  it("keeps the same native session on the same OAuth account while the sticky TTL is live", async () => {
    const pt: string[] = [];
    const selected: string[] = [];
    let clock = 1_000;
    const pool = createOAuthPoolClient({
      members: [ptMember("a", 50, pt), ptMember("b", 50, pt)],
      now: () => clock,
      stickyTtlMs: 100,
      onSelect: (acc) => selected.push(acc),
    });
    const firstSession = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5-codex", input: "hi" },
      headers: { session_id: "sess-1" },
      mutations: {},
    };
    const secondSession = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5-codex", input: "hi" },
      headers: { session_id: "sess-2" },
      mutations: {},
    };

    await pool.nativePassthrough?.(firstSession);
    clock += 10;
    await pool.nativePassthrough?.(firstSession);
    clock += 10;
    await pool.nativePassthrough?.(secondSession);

    expect(pt[1]).toBe(pt[0]);
    expect(selected[1]).toBe(selected[0]);
    expect(pt).toHaveLength(3);
    expect(selected).toHaveLength(3);
  });

  it("expires native sticky cache entries but recomputes the same deterministic account", async () => {
    const pt: string[] = [];
    let clock = 1_000;
    const pool = createOAuthPoolClient({
      members: [ptMember("a", 50, pt), ptMember("b", 50, pt)],
      now: () => clock,
      stickyTtlMs: 50,
    });
    const native = {
      protocol: "anthropic_messages" as const,
      body: { model: "claude", messages: [] },
      headers: { "x-session-id": "sess-expire" },
      mutations: {},
    };

    await pool.nativePassthrough?.(native);
    clock += 100;
    await pool.nativePassthrough?.(native);

    expect(pt).toHaveLength(2);
    expect(pt[1]).toBe(pt[0]);
  });

  it("keeps a native metadata.user_id device id on one account even when session ids change", async () => {
    const pt: string[] = [];
    const pool = createOAuthPoolClient({
      members: [ptMember("a", 50, pt), ptMember("b", 50, pt)],
    });
    const userId = (session: string) =>
      JSON.stringify({ device_id: "native-device-1", account_uuid: "", session_id: session });

    await pool.nativePassthrough?.({
      protocol: "anthropic_messages" as const,
      body: { model: "claude", messages: [], metadata: { user_id: userId("session-1") } },
      headers: {},
      mutations: {},
    });
    await pool.nativePassthrough?.({
      protocol: "anthropic_messages" as const,
      body: { model: "claude", messages: [], metadata: { user_id: userId("session-2") } },
      headers: {},
      mutations: {},
    });

    expect(pt).toHaveLength(2);
    expect(pt[1]).toBe(pt[0]);
  });

  it("prefers another account when a native sticky target is at capacity", async () => {
    const pt: string[] = [];
    const pool = createOAuthPoolClient({
      members: [{ ...ptMember("a", 50, pt), isAtCapacity: () => true }, ptMember("b", 50, pt)],
    });

    await pool.nativePassthrough?.({
      protocol: "anthropic_messages" as const,
      body: {
        model: "claude",
        messages: [{ role: "user", content: "hi" }],
        metadata: { conversation_id: "conv-b" },
      },
      headers: {},
      mutations: {},
    });

    expect(pt).toEqual(["b"]);
  });

  it("serializes native Responses input capacity checks through the same user-turn detector", async () => {
    const pt: string[] = [];
    const pool = createOAuthPoolClient({
      members: [{ ...ptMember("a", 50, pt), isAtCapacity: () => true }, ptMember("b", 50, pt)],
    });

    await pool.nativePassthrough?.({
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.5",
        input: [{ type: "message", role: "user", content: "hi" }],
        prompt_cache_key: "stick-a",
      },
      headers: {},
      mutations: {},
    });

    expect(pt).toEqual(["b"]);
  });

  it("ignores per-request x-client-request-id when a stable native body key exists", async () => {
    const pt: string[] = [];
    const pool = createOAuthPoolClient({
      members: [ptMember("a", 50, pt), ptMember("b", 50, pt)],
    });

    await pool.nativePassthrough?.({
      protocol: "openai_responses" as const,
      body: { model: "gpt-5.5", input: "hi", prompt_cache_key: "thread-a" },
      headers: { "x-client-request-id": "one" },
      mutations: {},
    });
    await pool.nativePassthrough?.({
      protocol: "openai_responses" as const,
      body: { model: "gpt-5.5", input: "hi", prompt_cache_key: "thread-a" },
      headers: { "x-client-request-id": "two" },
      mutations: {},
    });

    expect(pt).toHaveLength(2);
    expect(pt[1]).toBe(pt[0]);
  });

  it("throws fail-closed when the selected member lacks nativePassthrough (never falls back to a sibling)", async () => {
    const pt: string[] = [];
    // The lowest-priority (preferred) member has NO nativePassthrough; the pool must
    // throw rather than silently route to the translating sibling.
    const pool = createOAuthPoolClient({
      members: [ptMember("no-pt", 10, pt, { withPassthrough: false }), ptMember("has-pt", 50, pt)],
    });
    await expect(pool.nativePassthrough?.(NATIVE)).rejects.toThrow();
    // The sibling that CAN passthrough was never reached.
    expect(pt).toEqual([]);
  });
});

// Native protocol passthrough STREAMING (issue #217, Phase 2): the streaming sibling.
// Like chatCompletionStream, the pool must select() SYNCHRONOUSLY on the call turn
// (rotation + onSelect) BEFORE the first await — a stream method returns a lazy async
// iterable, so deferring select() into the body would skip rotation until the consumer
// drains. Fail-closed if the picked member lacks nativePassthroughStream.
describe("createOAuthPoolClient — nativePassthroughStream", () => {
  function ptStreamMember(
    account: string,
    priority: number,
    ptCalls: string[],
    opts?: { withPassthroughStream?: boolean },
  ): OAuthPoolMember {
    const base: ProviderClient = {
      async chatCompletion(_req: ChatCompletionRequest) {
        return { served_by: account };
      },
      async *chatCompletionStream(_req: ChatCompletionRequest) {
        yield `data: ${account}\n\n`;
      },
    };
    if (opts?.withPassthroughStream !== false) {
      base.nativePassthroughStream = async function* (_body: Record<string, unknown>) {
        ptCalls.push(account);
        yield `data: ${account}\n\n`;
      };
    }
    return { account, priority, schedulable: true, client: base };
  }

  const NATIVE: Record<string, unknown> = { model: "claude-x", stream: true, messages: [] };

  it("selects SYNCHRONOUSLY on the call turn (rotation + onSelect) before draining", async () => {
    const pt: string[] = [];
    const selected: string[] = [];
    let clock = 1;
    const pool = createOAuthPoolClient({
      members: [ptStreamMember("a", 50, pt), ptStreamMember("b", 50, pt)],
      now: () => clock++,
      onSelect: (acc) => selected.push(acc),
    });
    // Open both streams WITHOUT draining yet. select() (and thus onSelect + rotation)
    // must already have fired on the call turn — exactly like chatCompletionStream.
    const s1 = pool.nativePassthroughStream?.(NATIVE);
    const s2 = pool.nativePassthroughStream?.(NATIVE);
    expect(selected).toEqual(["a", "b"]);
    // Now drain both: the member generators run and record which account served.
    const chunks: string[] = [];
    for await (const c of s1 ?? []) chunks.push(c);
    for await (const c of s2 ?? []) chunks.push(c);
    expect(pt).toEqual(["a", "b"]);
    expect(chunks).toEqual(["data: a\n\n", "data: b\n\n"]);
  });

  it("prefers another account when a native stream sticky target is at capacity", async () => {
    const pt: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...ptStreamMember("a", 50, pt), isAtCapacity: () => true },
        ptStreamMember("b", 50, pt),
      ],
      onSelect: (acc) => selected.push(acc),
    });

    const stream = pool.nativePassthroughStream?.({
      protocol: "anthropic_messages" as const,
      body: {
        model: "claude",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        metadata: { conversation_id: "conv-b" },
      },
      headers: {},
      mutations: {},
    });
    const chunks: string[] = [];
    for await (const c of stream ?? []) chunks.push(c);

    expect(pt).toEqual(["b"]);
    expect(selected).toEqual(["b"]);
    expect(chunks).toEqual(["data: b\n\n"]);
  });

  it("applies capacity checks to native Responses input streams", async () => {
    const pt: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...ptStreamMember("a", 50, pt), isAtCapacity: () => true },
        ptStreamMember("b", 50, pt),
      ],
      onSelect: (acc) => selected.push(acc),
    });

    const stream = pool.nativePassthroughStream?.({
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "hi" }],
        prompt_cache_key: "stick-a",
      },
      headers: {},
      mutations: {},
    });
    const chunks: string[] = [];
    for await (const c of stream ?? []) chunks.push(c);

    expect(pt).toEqual(["b"]);
    expect(selected).toEqual(["b"]);
    expect(chunks).toEqual(["data: b\n\n"]);
  });

  it("keeps a Responses websocket session on its owning account under capacity", async () => {
    const pt: string[] = [];
    let aBusy = false;
    const pool = createOAuthPoolClient({
      members: [
        { ...ptStreamMember("a", 50, pt), isAtCapacity: () => aBusy },
        ptStreamMember("b", 50, pt),
      ],
    });
    const session = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5.6-sol", stream: true, input: "turn" },
      headers: { [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "ws-1" },
      mutations: {},
    };

    for await (const _chunk of pool.nativePassthroughStream?.(session) ?? []) {
    }
    aBusy = true;
    for await (const _chunk of pool.nativePassthroughStream?.(session) ?? []) {
    }

    expect(pt).toEqual(["a", "a"]);
  });

  it("does not let previous_response_id override a strict Codex turn state", async () => {
    const pt: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...ptStreamMember("a", 50, pt), schedulable: false },
        ptStreamMember("b", 50, pt),
      ],
    });

    await expect(
      (async () => {
        for await (const _chunk of pool.nativePassthroughStream?.(
          {
            protocol: "openai_responses" as const,
            body: {
              model: "gpt-5.6-sol",
              stream: true,
              input: "turn",
              previous_response_id: "resp-a",
            },
            headers: { "x-codex-turn-state": "turn-a" },
            mutations: {},
          },
          { statefulAccount: "a" },
        ) ?? []) {
        }
      })(),
    ).rejects.toThrow(/original account is unavailable/);
    expect(pt).toEqual([]);
  });

  it("binds a streamed Responses response id to the account that produced it", async () => {
    const calls: string[] = [];
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion() {
          return { served_by: account };
        },
        async *chatCompletionStream() {
          yield `data: ${account}\n\n`;
        },
        async *nativePassthroughStream() {
          calls.push(account);
          yield 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-';
          yield `${account}"}}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
      now: () => 1_000,
    });

    const first = pool.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: { model: "gpt-5.6-sol", stream: true, input: "first" },
      headers: {},
      mutations: {},
    });
    for await (const _chunk of first ?? []) {
      // Drain the stream so the response.created frame can establish affinity.
    }

    const continuation = pool.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: {
        model: "gpt-5.6-sol",
        stream: true,
        input: "continue",
        previous_response_id: "resp-a",
      },
      headers: {},
      mutations: {},
    });
    for await (const _chunk of continuation ?? []) {
      // Drain the continuation.
    }

    expect(calls).toEqual(["a", "a"]);
  });

  it("does not move a known previous_response_id to a sibling after an upstream invalid-id", async () => {
    const calls: string[] = [];
    const invalidPreviousResponseId = new UpstreamError(
      "upstream_error",
      "Invalid `previous_response_id`.",
      { error: { type: "invalid_request_error" } },
      400,
    );
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion() {
          return { served_by: account };
        },
        async *chatCompletionStream() {
          yield `data: ${account}\n\n`;
        },
        async *nativePassthroughStream() {
          calls.push(account);
          if (account === "a") throw invalidPreviousResponseId;
          yield `event: response.created\ndata: {"type":"response.created","response":{"id":"resp-next"}}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
      now: () => 1_000,
    });
    const drain = async (statefulAccount?: string): Promise<void> => {
      const stream = pool.nativePassthroughStream?.(
        {
          protocol: "openai_responses",
          body: {
            model: "gpt-5.6-sol",
            stream: true,
            input: "continue",
            previous_response_id: "resp-original",
          },
          headers: {},
          mutations: {},
        },
        statefulAccount ? { statefulAccount } : undefined,
      );
      for await (const _chunk of stream ?? []) {
        // Drain until the account search completes.
      }
    };

    await expect(drain("a")).rejects.toThrow("Invalid `previous_response_id`.");

    expect(calls).toEqual(["a"]);
  });

  it("prioritizes previous_response_id affinity over websocket session affinity", async () => {
    const calls: string[] = [];
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion() {
          return { served_by: account };
        },
        async *chatCompletionStream() {
          yield `data: ${account}\n\n`;
        },
        async *nativePassthroughStream() {
          calls.push(account);
          yield `event: response.created\ndata: {"type":"response.created","response":{"id":"resp-${account}"}}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
      selectionStrategy: "manual_priority",
      now: () => 1_000,
    });

    const first = pool.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: { model: "gpt-5.6-sol", stream: true, input: "first" },
      headers: {},
      mutations: {},
    });
    for await (const _chunk of first ?? []) {
      // Drain so resp-a is bound to account a.
    }
    const websocketWarmup = pool.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: { model: "gpt-5.6-sol", stream: true, input: "warmup" },
      headers: { [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "session-b" },
      mutations: {},
    });
    for await (const _chunk of websocketWarmup ?? []) {
      // Drain so session-b is bound to account b.
    }
    const continuation = pool.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: {
        model: "gpt-5.6-sol",
        stream: true,
        input: "continue",
        previous_response_id: "resp-a",
      },
      headers: { [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "session-b" },
      mutations: {},
    });
    for await (const _chunk of continuation ?? []) {
      // Drain the continuation.
    }

    expect(calls).toEqual(["a", "b", "a"]);
  });

  it("binds an upstream x-codex-turn-state to the account that produced it", async () => {
    const calls: string[] = [];
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion() {
          return { served_by: account };
        },
        async *chatCompletionStream() {
          yield `data: ${account}\n\n`;
        },
        async *nativePassthroughStream(_body, opts) {
          calls.push(account);
          opts?.onResponseMeta?.(
            new Headers({
              "x-codex-turn-state": "turn-state-b",
              "x-request-id": `req-${account}`,
            }),
          );
          yield `event: response.created\ndata: {"type":"response.created","response":{"id":"resp-${account}"}}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
    });
    const firstMeta: string[] = [];

    const first = pool.nativePassthroughStream?.(
      {
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", stream: true, input: "first" },
        headers: { "session-id": "session-stable" },
        mutations: {},
      },
      {
        onResponseMeta: (headers) => {
          firstMeta.push(headers.get("x-request-id") ?? "");
        },
      },
    );
    for await (const _chunk of first ?? []) {
      // Drain the stream so response metadata can establish account affinity.
    }

    const continuation = pool.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: { model: "gpt-5.6-sol", stream: true, input: "continue" },
      headers: { "x-codex-turn-state": "turn-state-b" },
      mutations: {},
    });
    for await (const _chunk of continuation ?? []) {
      // Drain the continuation.
    }

    expect(calls).toEqual(["a", "a"]);
    expect(firstMeta).toEqual(["req-a"]);
  });

  it("never retries a known x-codex-turn-state on a sibling after a transient fault", async () => {
    const calls: string[] = [];
    let firstAccountCalls = 0;
    const transient = new UpstreamError("upstream_error", "fetch failed", null, null);
    const responseMember = (account: string, priority: number): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion() {
          return { served_by: account };
        },
        async *chatCompletionStream() {
          yield `data: ${account}\n\n`;
        },
        async *nativePassthroughStream(_body, opts) {
          calls.push(account);
          if (account === "a" && firstAccountCalls++ > 0) throw transient;
          opts?.onResponseMeta?.(new Headers({ "x-codex-turn-state": "strict-turn-state" }));
          yield `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-${account}"}}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a", 10), responseMember("b", 50)],
    });
    const drain = async (headers: Record<string, string>): Promise<void> => {
      const stream = pool.nativePassthroughStream?.({
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", stream: true, input: "continue" },
        headers,
        mutations: {},
      });
      for await (const _chunk of stream ?? []) {
        // Drain until the strict continuation either completes or fails.
      }
    };

    await drain({ "session-id": "initial-session" });
    await expect(drain({ "x-codex-turn-state": "strict-turn-state" })).rejects.toBe(transient);

    expect(calls).toEqual(["a", "a"]);
  });

  it("fails a known x-codex-turn-state when its original account is unavailable", async () => {
    const calls: string[] = [];
    const responseMember = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion() {
          return { served_by: account };
        },
        async *chatCompletionStream() {
          yield `data: ${account}\n\n`;
        },
        async *nativePassthroughStream(_body, opts) {
          calls.push(account);
          opts?.onResponseMeta?.(new Headers({ "x-codex-turn-state": "strict-turn-state" }));
          yield `event: response.created\ndata: {"type":"response.created","response":{"id":"resp-${account}"}}\n\n`;
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [responseMember("a"), responseMember("b")],
      now: () => 1_000,
    });

    const first = pool.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: { model: "gpt-5.6-sol", stream: true, input: "first" },
      headers: { "session-id": "session-stable" },
      mutations: {},
    });
    for await (const _chunk of first ?? []) {
      // Drain the stream so response metadata can establish account affinity.
    }
    pool.setUsageLimit("a", 50_000);

    expect(() =>
      pool.nativePassthroughStream?.({
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", stream: true, input: "continue" },
        headers: { "x-codex-turn-state": "strict-turn-state" },
        mutations: {},
      }),
    ).toThrow(/x-codex-turn-state.*original account.*unavailable/i);
    expect(calls).toEqual(["a"]);
  });

  it("throws fail-closed when the selected member lacks nativePassthroughStream", async () => {
    const pt: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        ptStreamMember("no-pt", 10, pt, { withPassthroughStream: false }),
        ptStreamMember("has-pt", 50, pt),
      ],
    });
    expect(() => pool.nativePassthroughStream?.(NATIVE)).toThrow();
    // The sibling that CAN passthrough-stream was never reached.
    expect(pt).toEqual([]);
  });
});

describe("createOAuthPoolClient — responsesCompact", () => {
  function compactMember(account: string, calls: string[]): OAuthPoolMember {
    return {
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion() {
          return { served_by: account };
        },
        async *chatCompletionStream() {
          yield `data: ${account}\n\n`;
        },
        async responsesCompact() {
          calls.push(account);
          return { output: [{ type: "message", role: "assistant", content: account }] };
        },
      },
    };
  }

  it("keeps compact requests with Codex session-id/thread-id headers on one account", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [compactMember("a", calls), compactMember("b", calls)],
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5.6-sol", input: "compact me" },
      headers: {
        "session-id": "session-stable",
        "thread-id": "thread-stable",
      },
      mutations: {},
    };

    await pool.responsesCompact?.(carrier);
    await pool.responsesCompact?.(carrier);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
  });

  it("filters compact account selection by the requested model entitlement", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...compactMember("sol", calls), models: ["gpt-5.6-sol"] },
        { ...compactMember("luna", calls), models: ["gpt-5.6-luna"] },
      ],
    });

    await pool.responsesCompact?.({ model: "gpt-5.6-luna", input: "compact" });

    expect(calls).toEqual(["luna"]);
  });

  it("uses compact response turn-state metadata to preserve account affinity", async () => {
    const calls: string[] = [];
    const compactMemberWithMeta = (account: string): OAuthPoolMember => ({
      account,
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion() {
          return { served_by: account };
        },
        async *chatCompletionStream() {
          yield `data: ${account}\n\n`;
        },
        async responsesCompact(_req, opts) {
          calls.push(account);
          opts?.onResponseMeta?.(
            new Headers({
              "x-codex-turn-state": "compact-turn-state-b",
              "x-request-id": `compact-${account}`,
            }),
          );
          return { output: [] };
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [compactMemberWithMeta("a"), compactMemberWithMeta("b")],
    });
    const forwardedRequestIds: string[] = [];

    await pool.responsesCompact?.(
      {
        protocol: "openai_responses",
        body: { model: "gpt-5.6-sol", input: "first compact" },
        headers: { "session-id": "session-stable" },
        mutations: {},
      },
      {
        onResponseMeta: (headers) => {
          forwardedRequestIds.push(headers.get("x-request-id") ?? "");
        },
      },
    );
    await pool.responsesCompact?.({
      protocol: "openai_responses",
      body: { model: "gpt-5.6-sol", input: "next compact" },
      headers: { "x-codex-turn-state": "compact-turn-state-b" },
      mutations: {},
    });

    expect(calls).toEqual(["a", "a"]);
    expect(forwardedRequestIds).toEqual(["compact-a"]);
  });

  it("does not advertise compact when pool members do not implement it", () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
    });

    expect(pool.responsesCompact).toBeUndefined();
  });
});

describe("createOAuthPoolClient — media", () => {
  function mediaMember(
    account: string,
    priority: number,
    calls: string[],
    opts: { imageFailure?: Error; videoFailure?: Error; extensionFailure?: Error } = {},
  ): OAuthPoolMember {
    return {
      account,
      priority,
      schedulable: true,
      client: {
        ...stubClient(account, []),
        async imageGeneration() {
          calls.push(`image:${account}`);
          if (opts.imageFailure) throw opts.imageFailure;
          return { data: [{ served_by: account }] };
        },
        async imageEdit() {
          calls.push(`edit:${account}`);
          return { data: [{ served_by: account }] };
        },
        async videoGeneration() {
          calls.push(`video:${account}`);
          if (opts.videoFailure) throw opts.videoFailure;
          return { request_id: `request-${account}` };
        },
        async videoExtension() {
          calls.push(`extension:${account}`);
          if (opts.extensionFailure) throw opts.extensionFailure;
          return { request_id: `extension-${account}` };
        },
        async videoRetrieve(_requestId, options) {
          calls.push(`retrieve:${account}`);
          return {
            status: "pending",
            provider_account: options?.providerAccount ?? options?.statefulAccount,
          };
        },
      },
    };
  }

  it("selects one account for a paid media create and never changes sibling after ambiguity", async () => {
    const calls: string[] = [];
    const selected: string[] = [];
    const ambiguous = new UpstreamError("timeout", "media create outcome unknown", null, null);
    const pool = createOAuthPoolClient({
      members: [
        mediaMember("a", 10, calls, { imageFailure: ambiguous, videoFailure: ambiguous }),
        mediaMember("b", 10, calls),
      ],
    });

    await expect(
      pool.imageGeneration?.(
        { model: "grok-imagine-image-quality" },
        {
          onAccountSelected: (account) => {
            selected.push(`image:${account}`);
          },
        },
      ),
    ).rejects.toBe(ambiguous);
    const videoPool = createOAuthPoolClient({
      members: [
        mediaMember("a", 10, calls, { videoFailure: ambiguous }),
        mediaMember("b", 10, calls),
      ],
    });
    await expect(
      videoPool.videoGeneration?.(
        { model: "grok-imagine-video" },
        {
          onAccountSelected: (account) => {
            selected.push(`video:${account}`);
          },
        },
      ),
    ).rejects.toBe(ambiguous);
    const extensionPool = createOAuthPoolClient({
      members: [
        mediaMember("a", 10, calls, { extensionFailure: ambiguous }),
        mediaMember("b", 10, calls),
      ],
    });
    await expect(
      extensionPool.videoExtension?.(
        { model: "grok-imagine-video" },
        {
          onAccountSelected: (account) => {
            selected.push(`extension:${account}`);
          },
        },
      ),
    ).rejects.toBe(ambiguous);

    expect(calls).toEqual(["image:a", "video:a", "extension:a"]);
    expect(selected).toEqual(["image:a", "video:a", "extension:a"]);
  });

  it("pins video retrieval to either persisted account carrier without rotating to a sibling", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [mediaMember("a", 10, calls), mediaMember("b", 10, calls)],
    });

    await expect(pool.videoRetrieve?.("request-a", { statefulAccount: "a" })).resolves.toEqual({
      status: "pending",
      provider_account: "a",
    });
    await expect(pool.videoRetrieve?.("request-b", { providerAccount: "b" })).resolves.toEqual({
      status: "pending",
      provider_account: "b",
    });

    expect(calls).toEqual(["retrieve:a", "retrieve:b"]);
  });

  it("removes an expired model entitlement from discovery and paid create selection", async () => {
    let nowMs = 1_000;
    const calls: string[] = [];
    const entitled = mediaMember("paid", 10, calls);
    entitled.models = ["grok-imagine-image", "grok-4.5"];
    entitled.modelValidUntilMs = { "grok-imagine-image": 1_500 };
    const pool = createOAuthPoolClient({ members: [entitled], now: () => nowMs });

    expect(pool.hasAvailableModel("grok-imagine-image")).toBe(true);
    nowMs = 1_500;
    expect(pool.hasAvailableModel("grok-imagine-image")).toBe(false);
    expect(pool.hasAvailableModel("grok-4.5")).toBe(true);
    await expect(
      pool.imageGeneration?.({ model: "grok-imagine-image", prompt: "draw" }),
    ).rejects.toThrow('no account supports model "grok-imagine-image"');
    expect(calls).toEqual([]);
  });
});

// In-pool retry (the real fix for the Codex `all_providers_failed` on a single OpenAI
// overload): when the picked account fails with a TRANSIENT, account-agnostic upstream
// fault BEFORE the first chunk, try the next eligible sibling in the SAME pool before the
// executor advances to the (cross-protocol-incompatible) next alias. A 429 cools its
// resolved account/model scope before retry; deterministic non-429 4xx errors are not retried.
describe("createOAuthPoolClient — in-pool retry on transient upstream fault", () => {
  // Member whose complete/stream throws a chosen error (or serves) — `served` records
  // which account actually produced a result, so a test asserts who served vs was skipped.
  function faultMember(
    account: string,
    priority: number,
    served: string[],
    fault: Error | null,
    opts?: { failMidStream?: boolean },
  ): OAuthPoolMember {
    return {
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          if (fault) throw fault;
          served.push(account);
          return { served_by: account };
        },
        chatCompletionStream(_req: ChatCompletionRequest): AsyncIterable<string> {
          return (async function* () {
            // Pre-first-chunk fault: throw BEFORE yielding (the breaker/retry boundary).
            if (fault && !opts?.failMidStream) throw fault;
            served.push(account);
            yield `data: ${account}\n\n`;
            // Mid-stream fault: already committed — must NOT trigger a sibling retry.
            if (fault && opts?.failMidStream) throw fault;
          })();
        },
      },
    };
  }

  const OVERLOAD = new UpstreamError("upstream_error", "overloaded", null, null);
  const FIVE_XX = new UpstreamError("upstream_error", "bad gateway", null, 502);
  const RATE = new UpstreamError("upstream_error", "usage limit", null, 429);
  const AUTH_401 = new UpstreamError("upstream_error", "unauthorized", null, 401);
  const AUTH_403 = new UpstreamError("upstream_error", "forbidden", null, 403);
  const BAD = new UpstreamError("upstream_error", "bad request", null, 400);
  const REFRESH_401 = new TokenRefreshError(
    "oauth refresh failed (openai-codex, status 401)",
    401,
    true,
  );
  const REFRESH_429 = new TokenRefreshError("oauth refresh rate-limited (status 429)", 429);
  const SHORT_LEASE = new TokenRefreshError(
    "oauth access token is shorter than required request lease",
    null,
    false,
    true,
  );
  const QUEUE_TIMEOUT = Object.assign(new Error("user message queue wait timed out"), {
    queueTimeout: true,
  });

  it("retries the next account on a transient fault (non-stream)", async () => {
    const served: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        faultMember("a", 10, served, OVERLOAD), // preferred, but overloaded
        faultMember("b", 50, served, null),
      ],
    });
    const res = await pool.chatCompletion(REQ);
    expect(res).toEqual({ served_by: "b" });
    expect(served).toEqual(["b"]); // a never served; b rescued the request
  });

  it("retries only sibling accounts that support the requested model", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        { ...faultMember("sol-bad", 10, served, FIVE_XX), models: ["gpt-5.6-sol"] },
        { ...faultMember("luna-only", 20, served, null), models: ["gpt-5.6-luna"] },
        { ...faultMember("sol-good", 30, served, null), models: ["gpt-5.6-sol"] },
      ],
      onSelect: (account) => selected.push(account),
    });

    await expect(pool.chatCompletion({ ...REQ, model: "gpt-5.6-sol" })).resolves.toEqual({
      served_by: "sol-good",
    });
    expect(selected).toEqual(["sol-bad", "sol-good"]);
    expect(served).toEqual(["sol-good"]);
  });

  it("parks a rate-limited account and retries a sibling before surfacing to the alias breaker", async () => {
    const served: string[] = [];
    const limited: Array<{ account: string; untilMs: number }> = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("a", 10, served, RATE), faultMember("b", 50, served, null)],
      now: () => 1_000,
      accountRateLimitCooldownMs: 250,
      onAccountRateLimit: (account, untilMs) => limited.push({ account, untilMs }),
      onSelect: (account) => selected.push(account),
    });

    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "b" });
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "b" });
    expect(served).toEqual(["b", "b"]);
    expect(selected).toEqual(["a", "b", "b"]);
    expect(limited).toEqual([{ account: "a", untilMs: 1_250 }]);
  });

  it("treats an account queue timeout as sibling capacity failover", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        faultMember("busy", 10, served, QUEUE_TIMEOUT),
        faultMember("open", 50, served, null),
      ],
      onSelect: (account) => selected.push(account),
    });

    await expect(pool.chatCompletion(USER_REQ)).resolves.toEqual({ served_by: "open" });

    expect(served).toEqual(["open"]);
    expect(selected).toEqual(["busy", "open"]);
  });

  it("treats a chat stream queue timeout as sibling capacity failover", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        faultMember("busy", 10, served, QUEUE_TIMEOUT),
        faultMember("open", 50, served, null),
      ],
      onSelect: (account) => selected.push(account),
    });

    const chunks: string[] = [];
    for await (const c of pool.chatCompletionStream(USER_REQ)) chunks.push(c);

    expect(chunks).toEqual(["data: open\n\n"]);
    expect(served).toEqual(["open"]);
    expect(selected).toEqual(["busy", "open"]);
  });

  it("can retry a sibling on a model-scoped 429 without globally parking the account", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const limited: Array<{ account: string; untilMs: number }> = [];
    const scopedModelMember = (account: string, priority: number): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(req: ChatCompletionRequest) {
          if (req.model === "claude-fable-5") throw RATE;
          served.push(account);
          return { served_by: account };
        },
        chatCompletionStream(_req: ChatCompletionRequest): AsyncIterable<string> {
          return (async function* () {})();
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [
        scopedModelMember("a", 10),
        { ...member("b", 50, true, served), client: stubClient("b", served) },
      ],
      now: () => 1_000,
      accountRateLimitCooldownMs: 250,
      shouldParkRateLimit: ({ model }) => model !== "claude-fable-5",
      onAccountRateLimit: (account, untilMs) => limited.push({ account, untilMs }),
      onSelect: (account) => selected.push(account),
    });

    await expect(pool.chatCompletion({ model: "claude-fable-5", messages: [] })).resolves.toEqual({
      served_by: "b",
    });
    await expect(pool.chatCompletion({ model: "claude-opus-4-6", messages: [] })).resolves.toEqual({
      served_by: "a",
    });

    expect(pool.getUsageLimit("a")).toBeNull();
    expect(limited).toEqual([]);
    expect(selected).toEqual(["a", "b", "a"]);
    expect(served).toEqual(["b", "a"]);
  });

  it("cools a Codex model/limit scope without parking the account for sibling models", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    let nowMs = 1_000;
    let lunaFailures = 1;
    const scoped429 = new UpstreamError(
      "upstream_error",
      "usage limit",
      { headers: { "x-codex-active-limit": "codex_luna" } },
      429,
    );
    const scopedMember: OAuthPoolMember = {
      account: "a",
      priority: 10,
      schedulable: true,
      client: {
        async chatCompletion(req: ChatCompletionRequest) {
          if (req.model === "gpt-5.6-luna" && lunaFailures-- > 0) throw scoped429;
          served.push(`a:${req.model}`);
          return { served_by: "a" };
        },
        chatCompletionStream(_req: ChatCompletionRequest): AsyncIterable<string> {
          return (async function* () {})();
        },
      },
    };
    const sibling: OAuthPoolMember = {
      account: "b",
      priority: 50,
      schedulable: true,
      client: {
        async chatCompletion(req: ChatCompletionRequest) {
          served.push(`b:${req.model}`);
          return { served_by: "b" };
        },
        chatCompletionStream(_req: ChatCompletionRequest): AsyncIterable<string> {
          return (async function* () {})();
        },
      },
    };
    const pool = createOAuthPoolClient({
      members: [scopedMember, sibling],
      now: () => nowMs,
      accountRateLimitCooldownMs: 250,
      resolveRateLimitScope: ({ model, error }) =>
        error === scoped429
          ? { scope: "model", model: model ?? "", limitId: "codex_luna" }
          : { scope: "account" },
      onSelect: (account) => selected.push(account),
    });

    await expect(pool.chatCompletion({ model: "gpt-5.6-luna", messages: [] })).resolves.toEqual({
      served_by: "b",
    });
    await expect(pool.chatCompletion({ model: "gpt-5.6-luna", messages: [] })).resolves.toEqual({
      served_by: "b",
    });
    await expect(pool.chatCompletion({ model: "gpt-5.6-terra", messages: [] })).resolves.toEqual({
      served_by: "a",
    });

    expect(pool.getUsageLimit("a")).toBeNull();
    expect(selected).toEqual(["a", "b", "b", "a"]);
    expect(served).toEqual(["b:gpt-5.6-luna", "b:gpt-5.6-luna", "a:gpt-5.6-terra"]);

    nowMs = 1_251;
    await expect(pool.chatCompletion({ model: "gpt-5.6-luna", messages: [] })).resolves.toEqual({
      served_by: "a",
    });
    expect(served.at(-1)).toBe("a:gpt-5.6-luna");
  });

  it("keeps the default Codex limit account-scoped", async () => {
    const served: string[] = [];
    const account429 = new UpstreamError(
      "upstream_error",
      "usage limit",
      { headers: { "x-codex-active-limit": "codex" } },
      429,
    );
    const pool = createOAuthPoolClient({
      members: [
        faultMember("a", 10, served, account429),
        {
          ...member("b", 50, true, served),
          client: {
            async chatCompletion(req: ChatCompletionRequest) {
              served.push(`b:${req.model}`);
              return { served_by: "b" };
            },
            chatCompletionStream(_req: ChatCompletionRequest): AsyncIterable<string> {
              return (async function* () {})();
            },
          },
        },
      ],
      now: () => 1_000,
      accountRateLimitCooldownMs: 250,
      resolveRateLimitScope: () => ({ scope: "account" }),
    });

    await expect(pool.chatCompletion({ model: "gpt-5.6-luna", messages: [] })).resolves.toEqual({
      served_by: "b",
    });
    await expect(pool.chatCompletion({ model: "gpt-5.6-terra", messages: [] })).resolves.toEqual({
      served_by: "b",
    });
    expect(pool.getUsageLimit("a")).toBe(1_250);
  });

  it("parks a refresh-rate-limited account (TokenRefreshError 429) and retries a sibling", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("bad", 10, served, REFRESH_429), faultMember("good", 50, served, null)],
      now: () => 1_000,
      accountRateLimitCooldownMs: 250,
      onSelect: (account) => selected.push(account),
    });
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    expect(served).toEqual(["good", "good"]);
    expect(selected).toEqual(["bad", "good", "good"]); // bad stays cooled on the 2nd request
  });

  it("retries a sibling for a short token lease without permanently parking the account", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const credentialFailures: string[] = [];
    let now = 1_000;
    const pool = createOAuthPoolClient({
      members: [
        faultMember("short", 10, served, SHORT_LEASE),
        faultMember("good", 50, served, null),
      ],
      now: () => now,
      onSelect: (account) => selected.push(account),
      onAccountCredentialFailure: (account) => credentialFailures.push(account),
    });

    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    now += 60_000;
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    expect(selected).toEqual(["short", "good", "good", "short", "good"]);
    expect(credentialFailures).toEqual([]);
  });

  it("clears a retryable refresh cooldown when an account test succeeds", async () => {
    let refreshFails = true;
    const pool = createOAuthPoolClient({
      members: [
        {
          account: "a",
          priority: 10,
          schedulable: true,
          client: {
            async chatCompletion() {
              if (refreshFails) {
                refreshFails = false;
                throw SHORT_LEASE;
              }
              return { served_by: "a" };
            },
            chatCompletionStream(): AsyncIterable<string> {
              return (async function* () {})();
            },
          },
        },
      ],
      now: () => 1_000,
    });

    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/shorter than required request lease/);
    pool.setUsageLimit("a", null);
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "a" });
  });

  it("cools a refresh-failed account for streaming requests too", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        faultMember("refreshing", 10, served, SHORT_LEASE),
        faultMember("good", 50, served, null),
      ],
      now: () => 1_000,
      onSelect: (account) => selected.push(account),
    });

    for await (const _chunk of pool.chatCompletionStream(REQ)) {
      // drain
    }
    for await (const _chunk of pool.chatCompletionStream(REQ)) {
      // drain
    }

    expect(selected).toEqual(["refreshing", "good", "good"]);
    expect(served).toEqual(["good", "good"]);
  });

  it("a rate-limit park never SHORTENS a precise quota cooldown already set (extend-only)", async () => {
    const served: string[] = [];
    const limited: Array<{ account: string; untilMs: number }> = [];
    const FAR = 9_000_000; // a precise Codex weekly reset, far past now()+cooldown
    let poolRef: ReturnType<typeof createOAuthPoolClient> | undefined;
    const precise: OAuthPoolMember = {
      account: "a",
      priority: 10,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          // Mimic captureCodexQuota: the precise long reset lands BEFORE the 429 throws.
          poolRef?.setUsageLimit("a", FAR);
          throw RATE;
        },
        chatCompletionStream(_req: ChatCompletionRequest): AsyncIterable<string> {
          return (async function* () {})();
        },
      },
    };
    const pool = createOAuthPoolClient({
      members: [precise, faultMember("b", 50, served, null)],
      now: () => 1_000,
      accountRateLimitCooldownMs: 250,
      onAccountRateLimit: (account, untilMs) => limited.push({ account, untilMs }),
    });
    poolRef = pool;
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "b" });
    expect(pool.getUsageLimit("a")).toBe(FAR); // NOT pulled back to 1_000 + 250
    expect(limited).toEqual([{ account: "a", untilMs: FAR }]); // hook persists the kept value
  });

  it("does NOT retry on a deterministic 4xx", async () => {
    const served: string[] = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("a", 10, served, BAD), faultMember("b", 50, served, null)],
    });
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/bad request/);
    expect(served).toEqual([]);
  });

  it("parks a credential-failed account and retries a sibling before surfacing to the alias breaker", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const credentialFailures: Array<{ account: string; error: unknown }> = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("bad", 10, served, REFRESH_401), faultMember("good", 50, served, null)],
      onSelect: (account) => selected.push(account),
      onAccountCredentialFailure: (account, error) => {
        credentialFailures.push({ account, error });
      },
    });

    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });

    expect(served).toEqual(["good", "good"]);
    expect(selected).toEqual(["bad", "good", "good"]);
    expect(credentialFailures).toEqual([{ account: "bad", error: REFRESH_401 }]);
  });

  it("parks a permanent identity-mismatch refresh failure even without an HTTP status", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const identityMismatch = new TokenRefreshError(
      "oauth refresh failed (openai-codex)",
      null,
      true,
    );
    const credentialFailures: Array<{ account: string; error: unknown }> = [];
    const pool = createOAuthPoolClient({
      members: [
        faultMember("bad", 10, served, identityMismatch),
        faultMember("good", 50, served, null),
      ],
      onSelect: (account) => selected.push(account),
      onAccountCredentialFailure: (account, error) => {
        credentialFailures.push({ account, error });
      },
    });

    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });

    expect(served).toEqual(["good", "good"]);
    expect(selected).toEqual(["bad", "good", "good"]);
    expect(credentialFailures).toEqual([{ account: "bad", error: identityMismatch }]);
  });

  it("parks a persistent upstream auth failure and retries a sibling", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("bad", 10, served, AUTH_401), faultMember("good", 50, served, null)],
      onSelect: (account) => selected.push(account),
    });

    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });

    expect(served).toEqual(["good", "good"]);
    expect(selected).toEqual(["bad", "good", "good"]);
  });

  it("lets a provider exclude inference 403 from permanent credential failures", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const credentialFailures: Array<{ account: string; error: unknown }> = [];
    const pool = createOAuthPoolClient({
      members: [
        faultMember("first", 10, served, AUTH_403),
        faultMember("second", 50, served, null),
      ],
      upstreamCredentialFailureStatuses: [401],
      onSelect: (account) => selected.push(account),
      onAccountCredentialFailure: (account, error) => {
        credentialFailures.push({ account, error });
      },
    });

    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/forbidden/);
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/forbidden/);

    expect(served).toEqual([]);
    expect(selected).toEqual(["first", "first"]);
    expect(credentialFailures).toEqual([]);
  });

  it("does not park inference 403 as a permanent credential failure by default", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const credentialFailures: Array<{ account: string; error: unknown }> = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("bad", 10, served, AUTH_403), faultMember("good", 50, served, null)],
      onSelect: (account) => selected.push(account),
      onAccountCredentialFailure: (account, error) => {
        credentialFailures.push({ account, error });
      },
    });

    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/forbidden/);
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/forbidden/);

    expect(served).toEqual([]);
    expect(selected).toEqual(["bad", "bad"]);
    expect(credentialFailures).toEqual([]);
  });

  it("does not park a provider-excluded inference 403 on the streaming path", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const credentialFailures: Array<{ account: string; error: unknown }> = [];
    const pool = createOAuthPoolClient({
      members: [
        faultMember("first", 10, served, AUTH_403),
        faultMember("second", 50, served, null),
      ],
      upstreamCredentialFailureStatuses: [401],
      onSelect: (account) => selected.push(account),
      onAccountCredentialFailure: (account, error) => {
        credentialFailures.push({ account, error });
      },
    });
    const drain = async () => {
      for await (const _chunk of pool.chatCompletionStream(REQ)) {
        // A 403 fails before the first chunk.
      }
    };

    await expect(drain()).rejects.toThrow(/forbidden/);
    await expect(drain()).rejects.toThrow(/forbidden/);

    expect(served).toEqual([]);
    expect(selected).toEqual(["first", "first"]);
    expect(credentialFailures).toEqual([]);
  });

  it("surfaces the upstream fault (not pool-empty) when every account fails transiently", async () => {
    const served: string[] = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("a", 10, served, OVERLOAD), faultMember("b", 50, served, FIVE_XX)],
    });
    // The LAST transient error is surfaced — NOT the internal "no schedulable account".
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/bad gateway/);
  });

  it("retries the next account when a stream fails before its first chunk", async () => {
    const served: string[] = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("a", 10, served, OVERLOAD), faultMember("b", 50, served, null)],
    });
    const chunks: string[] = [];
    for await (const c of pool.chatCompletionStream(REQ)) chunks.push(c);
    expect(chunks).toEqual(["data: b\n\n"]);
    expect(served).toEqual(["b"]); // a threw pre-first-chunk → fell over to b
  });

  it("does NOT retry once a stream has emitted its first chunk (mid-stream fault)", async () => {
    const served: string[] = [];
    const pool = createOAuthPoolClient({
      members: [
        faultMember("a", 10, served, FIVE_XX, { failMidStream: true }),
        faultMember("b", 50, served, null),
      ],
    });
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const c of pool.chatCompletionStream(REQ)) chunks.push(c);
      })(),
    ).rejects.toThrow(/bad gateway/);
    expect(chunks).toEqual(["data: a\n\n"]); // committed to a after its first chunk
    expect(served).toEqual(["a"]); // never fell over to b — the bytes were already out
  });

  it("retries native passthrough streaming across accounts (the Codex case)", async () => {
    const served: string[] = [];
    const NATIVE: Record<string, unknown> = { model: "gpt-5.5", stream: true, messages: [] };
    const mk = (account: string, priority: number, fault: Error | null): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          return { served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          yield `data: ${account}\n\n`;
        },
        nativePassthroughStream(_body: Record<string, unknown>): AsyncIterable<string> {
          return (async function* () {
            if (fault) throw fault;
            served.push(account);
            yield `data: ${account}\n\n`;
          })();
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [mk("a", 10, OVERLOAD), mk("b", 50, null)],
    });
    const chunks: string[] = [];
    for await (const c of pool.nativePassthroughStream?.(NATIVE) ?? []) chunks.push(c);
    expect(chunks).toEqual(["data: b\n\n"]);
    expect(served).toEqual(["b"]);
  });

  it("rotates to a sibling Codex account after an exhausted raw fetch failure", async () => {
    const selected: string[] = [];
    const raw = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const codexMember = (
      account: string,
      priority: number,
      providerFetch: typeof fetch,
    ): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: createCodexResponsesClient({
        config: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          getAuthHeader: async () => `Bearer token-${account}`,
          connectRetries: 0,
        },
        fetch: providerFetch,
      }),
    });
    const pool = createOAuthPoolClient({
      members: [
        codexMember("a", 10, (async () => {
          throw raw;
        }) as unknown as typeof fetch),
        codexMember(
          "b",
          50,
          (async () =>
            new Response(
              'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-b","status":"completed"}}\n\n',
              { status: 200, headers: { "content-type": "text/event-stream" } },
            )) as unknown as typeof fetch,
        ),
      ],
      onSelect: (account) => selected.push(account),
    });
    const request = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5.6-sol", input: "full stateless history", stream: true, store: false },
      headers: { "session-id": "stateless-session" },
      mutations: {},
    };

    const chunks: string[] = [];
    for await (const chunk of pool.nativePassthroughStream?.(request) ?? []) chunks.push(chunk);

    expect(selected).toEqual(["a", "b"]);
    expect(chunks.join("")).toContain('"id":"resp-b"');
  });

  it("cools a Codex model-scoped 429 on native streaming without parking sibling models", async () => {
    const served: string[] = [];
    let nowMs = 1_000;
    let scopedFailures = 1;
    const scoped429 = new UpstreamError(
      "upstream_error",
      "usage limit",
      { headers: { "x-codex-active-limit": "codex_luna" } },
      429,
    );
    const mk = (account: string, priority: number): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          return { served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          yield `data: ${account}\n\n`;
        },
        nativePassthroughStream(body: Record<string, unknown>): AsyncIterable<string> {
          return (async function* () {
            const model = String(body.model ?? "");
            if (account === "a" && model === "gpt-5.6-luna" && scopedFailures-- > 0) {
              throw scoped429;
            }
            served.push(`${account}:${model}`);
            yield `data: ${account}\n\n`;
          })();
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [mk("a", 10), mk("b", 50)],
      now: () => nowMs,
      accountRateLimitCooldownMs: 250,
      resolveRateLimitScope: ({ model, error }) =>
        error === scoped429
          ? { scope: "model", model: model ?? "", limitId: "codex_luna" }
          : { scope: "account" },
    });
    const drain = async (model: string): Promise<void> => {
      const stream = pool.nativePassthroughStream?.({ model, stream: true, input: "hi" });
      for await (const _chunk of stream ?? []) {
        // Drain the stream so pre-first-chunk retry and cooldown selection execute.
      }
    };

    await drain("gpt-5.6-luna");
    await drain("gpt-5.6-luna");
    await drain("gpt-5.6-terra");

    expect(pool.getUsageLimit("a")).toBeNull();
    expect(served).toEqual(["b:gpt-5.6-luna", "b:gpt-5.6-luna", "a:gpt-5.6-terra"]);

    nowMs = 1_251;
    await drain("gpt-5.6-luna");
    expect(served.at(-1)).toBe("a:gpt-5.6-luna");
  });

  it("treats a native stream queue timeout as sibling capacity failover", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const NATIVE: Record<string, unknown> = {
      model: "gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const mk = (account: string, priority: number, fault: Error | null): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          return { served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          yield `data: ${account}\n\n`;
        },
        nativePassthroughStream(_body: Record<string, unknown>): AsyncIterable<string> {
          return (async function* () {
            if (fault) throw fault;
            served.push(account);
            yield `data: ${account}\n\n`;
          })();
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [mk("busy", 10, QUEUE_TIMEOUT), mk("open", 50, null)],
      onSelect: (account) => selected.push(account),
    });

    const chunks: string[] = [];
    for await (const c of pool.nativePassthroughStream?.(NATIVE) ?? []) chunks.push(c);

    expect(chunks).toEqual(["data: open\n\n"]);
    expect(served).toEqual(["open"]);
    expect(selected).toEqual(["busy", "open"]);
  });

  it("parks a credential-failed account and retries native passthrough streaming", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const NATIVE: Record<string, unknown> = { model: "gpt-5.4-mini", stream: true, messages: [] };
    const mk = (account: string, priority: number, fault: Error | null): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          return { served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          yield `data: ${account}\n\n`;
        },
        nativePassthroughStream(_body: Record<string, unknown>): AsyncIterable<string> {
          return (async function* () {
            if (fault) throw fault;
            served.push(account);
            yield `data: ${account}\n\n`;
          })();
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [mk("bad", 10, REFRESH_401), mk("good", 50, null)],
      onSelect: (account) => selected.push(account),
    });

    const chunks: string[] = [];
    for await (const c of pool.nativePassthroughStream?.(NATIVE) ?? []) chunks.push(c);

    expect(chunks).toEqual(["data: good\n\n"]);
    expect(served).toEqual(["good"]);
    expect(selected).toEqual(["bad", "good"]);
  });

  it("parks a persistent upstream auth failure and retries native passthrough streaming", async () => {
    const served: string[] = [];
    const selected: string[] = [];
    const NATIVE: Record<string, unknown> = { model: "gpt-5.4-mini", stream: true, messages: [] };
    const mk = (account: string, priority: number, fault: Error | null): OAuthPoolMember => ({
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          return { served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          yield `data: ${account}\n\n`;
        },
        nativePassthroughStream(_body: Record<string, unknown>): AsyncIterable<string> {
          return (async function* () {
            if (fault) throw fault;
            served.push(account);
            yield `data: ${account}\n\n`;
          })();
        },
      },
    });
    const pool = createOAuthPoolClient({
      members: [mk("bad", 10, AUTH_401), mk("good", 50, null)],
      onSelect: (account) => selected.push(account),
    });

    const chunks: string[] = [];
    for await (const c of pool.nativePassthroughStream?.(NATIVE) ?? []) chunks.push(c);

    expect(chunks).toEqual(["data: good\n\n"]);
    expect(served).toEqual(["good"]);
    expect(selected).toEqual(["bad", "good"]);
  });
});

// In-band pre-output failover (the real Codex `all_providers_failed`-on-one-overload
// case): a native passthrough that 200s, streams a content-free preamble
// (`response.created`), THEN fails (`response.failed`/server_is_overloaded) must NOT
// commit the account on the preamble — it must fail over to a sibling. The pool wraps
// each member's SSE with the protocol's pre-output guard so "commit on first raw chunk"
// becomes "commit on first REAL output".
describe("createOAuthPoolClient — in-band pre-output failover (preamble then error)", () => {
  const NATIVE: Record<string, unknown> = { model: "gpt-5.5", stream: true, messages: [] };
  const PREAMBLE = 'data: {"type":"response.created"}\n\n';
  const ERROR =
    'data: {"type":"response.failed","response":{"error":{"message":"overloaded"}}}\n\n';
  const OUTPUT = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';

  type Mode = "preamble_then_error" | "preamble_then_output" | "preamble_only";
  function nativeStreamMember(account: string, priority: number, mode: Mode): OAuthPoolMember {
    return {
      account,
      priority,
      schedulable: true,
      client: {
        async chatCompletion(_req: ChatCompletionRequest) {
          return { served_by: account };
        },
        async *chatCompletionStream(_req: ChatCompletionRequest) {
          yield `data: ${account}\n\n`;
        },
        nativePassthroughStream(_body: Record<string, unknown>): AsyncIterable<string> {
          return (async function* () {
            yield PREAMBLE; // content-free preamble — must NOT be a commit point
            if (mode === "preamble_only") return; // abnormal close, no output
            if (mode === "preamble_then_error") {
              yield ERROR;
              return;
            }
            yield OUTPUT;
          })();
        },
      },
    };
  }

  const responses = preOutputClassifierFor("openai_responses");

  it("fails over to the next account when the FIRST emits preamble-then-error", async () => {
    const pool = createOAuthPoolClient({
      members: [
        nativeStreamMember("a", 10, "preamble_then_error"),
        nativeStreamMember("b", 50, "preamble_then_output"),
      ],
      nativeStreamPreambleClassifier: responses,
    });
    const chunks: string[] = [];
    for await (const c of pool.nativePassthroughStream?.(NATIVE) ?? []) chunks.push(c);
    // b's real output arrived (with its replayed preamble); a's doomed stream never committed.
    expect(chunks).toContain(OUTPUT);
    expect(chunks.filter((c) => c === ERROR)).toEqual([]); // the error frame was never relayed
  });

  it("also fails over when the first account closes after only a preamble", async () => {
    const pool = createOAuthPoolClient({
      members: [
        nativeStreamMember("a", 10, "preamble_only"),
        nativeStreamMember("b", 50, "preamble_then_output"),
      ],
      nativeStreamPreambleClassifier: responses,
    });
    const chunks: string[] = [];
    for await (const c of pool.nativePassthroughStream?.(NATIVE) ?? []) chunks.push(c);
    expect(chunks).toContain(OUTPUT);
  });

  it("commits (no spurious retry) when the only account reaches real output", async () => {
    const pool = createOAuthPoolClient({
      members: [nativeStreamMember("solo", 10, "preamble_then_output")],
      nativeStreamPreambleClassifier: responses,
    });
    const chunks: string[] = [];
    for await (const c of pool.nativePassthroughStream?.(NATIVE) ?? []) chunks.push(c);
    expect(chunks).toEqual([PREAMBLE, OUTPUT]); // preamble replayed in order, then output
  });

  it("surfaces the upstream error when EVERY account fails pre-output (no sibling left)", async () => {
    const pool = createOAuthPoolClient({
      members: [
        nativeStreamMember("a", 10, "preamble_then_error"),
        nativeStreamMember("b", 50, "preamble_then_error"),
      ],
      nativeStreamPreambleClassifier: responses,
    });
    await expect(
      (async () => {
        for await (const _ of pool.nativePassthroughStream?.(NATIVE) ?? []) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/overloaded/);
  });
});
