import { describe, expect, it } from "vitest";
import type { ChatCompletionRequest, ProviderClient } from "../openai.js";
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
