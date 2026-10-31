import { describe, expect, it } from "vitest";
import { UpstreamError } from "../openai.js";
import { createOAuthPoolClient, type OAuthPoolMember, type OAuthPoolSelection } from "./pool.js";

describe("pool evidence and passive speed selection", () => {
  it("records candidate exclusions and quota freshness at selection time", async () => {
    let selection: OAuthPoolSelection | undefined;
    const client = {
      chatCompletion: async () => ({}),
      async *chatCompletionStream() {
        yield "data: [DONE]\n\n";
      },
    };
    const pool = createOAuthPoolClient({
      members: [
        {
          account: "healthy",
          priority: 1,
          schedulable: true,
          client,
          quotaCapturedAtMs: 100,
          quotaWindows: [{ key: "5h", usedPercent: 20, resetsAtMs: 10000, windowMinutes: 300 }],
        },
        { account: "disabled", priority: 1, schedulable: false, client },
      ],
      now: () => 200,
      selectionStrategy: "low_risk",
      onSelect: (_, value) => {
        selection = value;
      },
    });
    await pool.chatCompletion({ model: "m", messages: [] });
    expect(selection?.trace).toMatchObject({
      captured_at_ms: 200,
      strategy: "low_risk",
      candidates: [
        {
          account: "healthy",
          selected: true,
          exclusion: null,
          quota_fresh: true,
          quota_pressure: 20,
        },
        {
          account: "disabled",
          selected: false,
          exclusion: "disabled",
          quota_fresh: false,
          quota_pressure: null,
        },
      ],
    });
  });
  it("learns from normal streamed calls, then chooses faster accounts within the priority tier", async () => {
    let now = 1000;
    const calls: string[] = [];
    const members: OAuthPoolMember[] = ["slow", "fast"].map((account) => ({
      account,
      priority: 1,
      schedulable: true,
      client: {
        chatCompletion: async () => ({}),
        async *chatCompletionStream() {
          calls.push(account);
          now += account === "slow" ? 1000 : 20;
          yield 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n';
          now += 100;
          yield 'data: {"choices":[],"usage":{"completion_tokens":10}}\n\n';
          yield "data: [DONE]\n\n";
        },
      },
    }));
    const pool = createOAuthPoolClient({ members, now: () => now, selectionStrategy: "fastest" });
    for (let i = 0; i < 3; i++)
      for await (const _ of pool.chatCompletionStream({ model: "m", messages: [] })) {
        /* drain */
      }
    expect(calls).toEqual(["slow", "fast", "fast"]);
    // Availability remains authoritative, irrespective of a prior speed sample.
    pool.disableAccount("fast");
    for await (const _ of pool.chatCompletionStream({ model: "m", messages: [] })) {
      /* drain */
    }
    expect(calls.at(-1)).toBe("slow");
  });
});

describe("late-stream retry regression", () => {
  it("does not replay a partial answer and sends the next independent retry to a healthy sibling", async () => {
    const calls: string[] = [];
    const members: OAuthPoolMember[] = ["broken", "healthy"].map((account) => ({
      account,
      priority: 1,
      schedulable: true,
      client: {
        chatCompletion: async () => ({}),
        async *chatCompletionStream() {
          calls.push(account);
          yield `data: ${account}\n\n`;
          if (account === "broken")
            throw new UpstreamError("upstream_error", "upstream interrupted", null, 502);
        },
      },
    }));
    const pool = createOAuthPoolClient({ members, selectionStrategy: "manual_priority" });
    const request = { model: "m", messages: [], metadata: { session_id: "ordinary-session" } };
    const first: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of pool.chatCompletionStream(request)) first.push(chunk);
      })(),
    ).rejects.toThrow("upstream interrupted");
    expect(calls).toEqual(["broken"]);
    expect(first).toEqual(["data: broken\n\n"]);
    for await (const _ of pool.chatCompletionStream(request)) {
      /* next client request */
    }
    expect(calls).toEqual(["broken", "healthy"]);
  });
});
