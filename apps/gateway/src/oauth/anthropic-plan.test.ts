import { createSqliteDb, SqliteConfigStore } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicPlanAccess, parseAnthropicPlan } from "./anthropic-plan.js";

describe("Anthropic subscription plan", () => {
  it.each(["pro", "max", "team", "enterprise"])("reads official organization type %s", (plan) => {
    expect(parseAnthropicPlan({ organization: { organization_type: `claude_${plan}` } })).toBe(
      plan,
    );
  });
  it.each([
    null,
    {},
    { organization: { organization_type: "max" } },
    { organization: { rate_limit_tier: "default_claude_max_20x" } },
  ])("does not guess a plan from malformed or unrelated data", (body) => {
    expect(parseAnthropicPlan(body)).toBeNull();
  });
  function setup() {
    const config = new SqliteConfigStore(createSqliteDb(":memory:"));
    let time = 1000;
    const bindings = new Map([
      ["a", "credential-a"],
      ["b", "credential-b"],
    ]);
    const request = vi.fn(
      async (account: string): Promise<unknown> => ({
        organization: { organization_type: account === "a" ? "claude_pro" : "claude_max" },
      }),
    );
    const deps = {
      config,
      now: () => time,
      binding: async (account: string) => bindings.get(account) ?? null,
      fetchProfile: request,
    };
    return {
      deps,
      request,
      bindings,
      advance: () => {
        time += 300_001;
      },
    };
  }
  it("persists separate account plans across restart; cached reads never fetch", async () => {
    const { deps, request, advance } = setup();
    const access = createAnthropicPlanAccess(deps);
    expect(await access.get("a", false, false)).toEqual({ plan: null, checkedAt: null });
    expect(request).not.toHaveBeenCalled();
    expect((await access.get("a", true, false)).plan).toBe("pro");
    expect((await access.get("b", true, false)).plan).toBe("max");
    await access.get("a", true, false);
    expect(request).toHaveBeenCalledTimes(2);
    advance();
    expect(await createAnthropicPlanAccess(deps).get("a", false, false)).toEqual({
      plan: "pro",
      checkedAt: 1000,
    });
    expect(request).toHaveBeenCalledTimes(2);
    await access.get("a", true, false);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("force refresh clears an old plan on failure and caches the unknown result", async () => {
    const { deps, request } = setup();
    const access = createAnthropicPlanAccess(deps);
    await access.get("a", true, false);
    request.mockRejectedValue(new Error("upstream unavailable"));
    expect((await access.get("a", true, true)).plan).toBeNull();
    await access.get("a", true, false);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("invalidates credentials and discards a profile racing reconnect or logout", async () => {
    const { deps, request, bindings } = setup();
    const access = createAnthropicPlanAccess(deps);
    await access.get("a", true, false);
    bindings.set("a", "new-credential");
    expect((await access.get("a", false, false)).plan).toBeNull();
    request.mockImplementation(async () => {
      bindings.delete("a");
      return { organization: { organization_type: "claude_max" } };
    });
    expect((await access.get("a", true, true)).plan).toBeNull();
    bindings.set("a", "third-credential");
    expect((await access.get("a", false, false)).plan).toBeNull();
  });
});
