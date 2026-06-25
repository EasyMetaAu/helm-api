import { describe, expect, it } from "vitest";
import { preOutputClassifierFor } from "../failover-guard.js";
import { type ChatCompletionRequest, type ProviderClient, UpstreamError } from "../openai.js";
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

    expect(pt).toEqual(["a", "a", "b"]);
    expect(selected).toEqual(["a", "a", "b"]);
  });

  it("expires native sticky sessions and returns to LRU selection", async () => {
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

    expect(pt).toEqual(["a", "b"]);
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
    fault: UpstreamError | null,
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
  const BAD = new UpstreamError("upstream_error", "bad request", null, 400);

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

  it("does NOT retry on a 429 — left for the executor's per-account park", async () => {
    const served: string[] = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("a", 10, served, RATE), faultMember("b", 50, served, null)],
    });
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/usage limit/);
    expect(served).toEqual([]); // stopped at a's 429; b (healthy) was never tried
  });

  it("does NOT retry on a deterministic 4xx", async () => {
    const served: string[] = [];
    const pool = createOAuthPoolClient({
      members: [faultMember("a", 10, served, BAD), faultMember("b", 50, served, null)],
    });
    await expect(pool.chatCompletion(REQ)).rejects.toThrow(/bad request/);
    expect(served).toEqual([]);
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
    const mk = (
      account: string,
      priority: number,
      fault: UpstreamError | null,
    ): OAuthPoolMember => ({
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
