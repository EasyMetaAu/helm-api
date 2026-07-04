import { describe, expect, it } from "vitest";
import { preOutputClassifierFor } from "../failover-guard.js";
import { type ChatCompletionRequest, type ProviderClient, UpstreamError } from "../openai.js";
import { TokenRefreshError } from "../token-manager.js";
import { createOAuthPoolClient, type OAuthPoolMember } from "./pool.js";

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

describe("createOAuthPoolClient — account selection", () => {
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
    });

    await pool.chatCompletion(REQ);
    await pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-a" });

    expect(calls).toEqual(["a", "a"]);
  });

  it("does not hash an unknown previous_response_id as a fake stable account key", async () => {
    const calls: string[] = [];
    const pool = createOAuthPoolClient({
      members: [member("a", 50, true, calls), member("b", 50, true, calls)],
    });

    await pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-1" });
    await pool.chatCompletion({ ...USER_REQ, previous_response_id: "resp-2" });

    expect(calls).toEqual(["a", "b"]);
  });

  it("does not let previous_response_id override a stable chat user key", async () => {
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
    });

    await pool.chatCompletion(REQ);
    await pool.chatCompletion({
      ...USER_REQ,
      user: "stable-user",
      previous_response_id: "resp-a",
    });

    expect(calls).toEqual(["a", "b"]);
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

// In-pool retry (the real fix for the Codex `all_providers_failed` on a single OpenAI
// overload): when the picked account fails with a TRANSIENT, account-agnostic upstream
// fault BEFORE the first chunk, try the next eligible sibling in the SAME pool before the
// executor advances to the (cross-protocol-incompatible) next alias. A 429 / 4xx is NOT
// retried (the executor parks the account / the request is deterministically bad).
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
  const BAD = new UpstreamError("upstream_error", "bad request", null, 400);
  const REFRESH_401 = new TokenRefreshError("oauth refresh failed (openai-codex, status 401)", 401);
  const REFRESH_429 = new TokenRefreshError("oauth refresh rate-limited (status 429)", 429);
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
    const pool = createOAuthPoolClient({
      members: [faultMember("bad", 10, served, REFRESH_401), faultMember("good", 50, served, null)],
      onSelect: (account) => selected.push(account),
    });

    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });
    await expect(pool.chatCompletion(REQ)).resolves.toEqual({ served_by: "good" });

    expect(served).toEqual(["good", "good"]);
    expect(selected).toEqual(["bad", "good", "good"]);
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
