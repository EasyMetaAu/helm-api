import { createSqliteDb, SqliteConfigStore } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicResetAccess } from "./anthropic-reset.js";

const NOW = Date.parse("2026-09-25T08:00:00Z");
const ORG = "12345678-1234-4234-8234-123456789abc";
function usage(left = 2, percent = 95) {
  return {
    five_hour: { utilization: percent, resets_at: "2026-09-25T12:00:00Z" },
    seven_day: { utilization: percent, resets_at: "2026-09-29T00:00:00Z" },
    cedar_ember: {
      eligible: true,
      at_limit: false,
      exhausted: [],
      next_grant_id: "opus55",
      cooldown_until: null,
      grants: [
        {
          id: "opus55",
          label: "Opus 5.5",
          resets_total: 2,
          resets_left: left,
          starts_at: "2026-09-23T00:00:00Z",
          ends_at: "2026-10-23T00:00:00Z",
          clears: ["five_hour", "seven_day"],
          paused: false,
          usable_now: left > 0,
          use_requires_limit: false,
          blocking: [],
        },
      ],
    },
  };
}
function setup() {
  const config = new SqliteConfigStore(createSqliteDb(":memory:"));
  let body = usage();
  let profile: unknown = { organization: { uuid: ORG } };
  const post = vi.fn(async () => {
    body = usage(1, 0);
    return {
      result: "reset",
      grant_id: "opus55",
      resets_left: 1,
      cleared: ["five_hour", "seven_day"],
    };
  });
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (init?.method === "POST") return post();
    if (path === "/api/oauth/profile") return profile;
    if (path === "/api/oauth/usage?cedar_ember=1&skip_spend=1") return body;
    throw new Error(`Unexpected path ${path}`);
  });
  const deps = {
    config,
    now: () => NOW,
    getClient: async (_account: string) => request,
    listAccounts: async () => ["a", "sibling"],
    invalidate: vi.fn(),
  };
  return {
    access: createAnthropicResetAccess(deps),
    deps,
    request,
    post,
    setBody: (next: ReturnType<typeof usage>) => {
      body = next;
    },
    setProfile: (next: unknown) => {
      profile = next;
    },
  };
}
const input = { account: "a", grantId: "opus55", expectedResetsLeft: 2 };

describe("Anthropic manual reset", () => {
  it("reads only, then sends the selected grant to the trusted OAuth organization and verifies it", async () => {
    const s = setup();
    expect((await s.access.getAnthropicResetStatus({ account: "a" })).grants[0]?.resets_left).toBe(
      2,
    );
    expect(s.post).not.toHaveBeenCalled();
    const result = await s.access.consumeAnthropicReset(input);
    expect(result.result).toBe("reset");
    expect(result.affectedAccounts).toEqual(["a", "sibling"]);
    expect(result.status?.grants[0]?.resets_left).toBe(1);
    const call = s.request.mock.calls.find(([, init]) => init?.method === "POST");
    expect(call?.[0]).toBe(`/api/organizations/${ORG}/reset_rate_limits`);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      program: "cedar_ember",
      grant_id: "opus55",
      request_id: expect.any(String),
    });
    expect(s.deps.invalidate).toHaveBeenCalled();
  });

  it.each([
    "paused",
    "ineligible",
    "empty",
    "not_next",
    "requires_limit",
    "expired",
    "blocking",
    "stale_count",
  ])("rejects fresh %s evidence before POST", async (reason) => {
    const s = setup();
    const body = usage();
    const grant = body.cedar_ember.grants[0];
    if (!grant) throw new Error("test grant missing");
    if (reason === "paused") grant.paused = true;
    if (reason === "ineligible") body.cedar_ember.eligible = false;
    if (reason === "empty") grant.resets_left = 0;
    if (reason === "not_next") body.cedar_ember.next_grant_id = "different";
    if (reason === "requires_limit") grant.use_requires_limit = true;
    if (reason === "expired") grant.ends_at = "2026-09-24T00:00:00Z";
    if (reason === "blocking") Object.assign(grant, { blocking: ["seven_day_opus"] });
    if (reason === "stale_count") grant.resets_left = 1;
    s.setBody(body);
    await expect(s.access.consumeAnthropicReset(input)).rejects.toThrow();
    expect(s.post).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed organization identity", async () => {
    const s = setup();
    s.setProfile({ organization: { uuid: "../other" } });
    await expect(s.access.consumeAnthropicReset(input)).rejects.toThrow();
    expect(s.post).not.toHaveBeenCalled();
  });

  it("serializes sibling accounts sharing an organization", async () => {
    const s = setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    s.post.mockImplementationOnce(async () => {
      await pending;
      return {
        result: "reset",
        grant_id: "opus55",
        resets_left: 1,
        cleared: ["five_hour", "seven_day"],
      };
    });
    const first = s.access.consumeAnthropicReset(input);
    await vi.waitFor(() => expect(s.post).toHaveBeenCalledTimes(1));
    await expect(s.access.consumeAnthropicReset({ ...input, account: "sibling" })).rejects.toThrow(
      /progress/,
    );
    s.setBody(usage(1, 0));
    finish();
    await first;
    expect(s.post).toHaveBeenCalledTimes(1);
  });

  it("retains an uncertain attempt across restart and never blindly sends a second POST", async () => {
    const s = setup();
    s.post.mockRejectedValueOnce(new Error("socket closed"));
    expect((await s.access.consumeAnthropicReset(input)).result).toBe("unknown");
    const restarted = createAnthropicResetAccess(s.deps);
    expect((await restarted.getAnthropicResetStatus({ account: "sibling" })).pending).toBe(true);
    await expect(restarted.consumeAnthropicReset({ ...input, account: "sibling" })).rejects.toThrow(
      /unconfirmed/,
    );
    expect(s.post).toHaveBeenCalledTimes(1);
  });

  it("recovers a timed-out reset only from a reduced grant count and quota readback", async () => {
    const s = setup();
    s.post.mockImplementationOnce(async () => {
      s.setBody(usage(1, 0));
      throw new Error("timeout");
    });
    expect((await s.access.consumeAnthropicReset(input)).result).toBe("reset");
    expect(s.post).toHaveBeenCalledTimes(1);
  });

  it("does not report a reset from HTTP success alone", async () => {
    const s = setup();
    s.post.mockResolvedValueOnce({
      result: "reset",
      grant_id: "opus55",
      resets_left: 1,
      cleared: ["five_hour", "seven_day"],
    });
    expect((await s.access.consumeAnthropicReset(input)).result).toBe("unknown");
    expect((await s.access.getAnthropicResetStatus({ account: "a" })).pending).toBe(true);
  });
});
