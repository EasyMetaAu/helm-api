import { describe, expect, it } from "vitest";
import { resolveMemoryScope } from "./memory-scope.js";

// memory-scope — the gateway HTTP boundary that turns the four memory request
// headers into a resolved MemoryScope (docs/08). Pure over a header-getter so the
// SAME parser serves both Hono `c.req.header` and an IR-metadata getter, while
// packages/core stays framework-free (CLAUDE.md principle 1). Mode normalization
// is delegated to core's resolveMemoryMode (single source of truth); the scope
// ids fold absent/empty → null so an empty header never fabricates an id.

// A header-getter over a plain map (mirrors Hono's c.req.header(name) contract:
// returns the value or undefined). Header names are matched case-insensitively
// the way Hono normalizes them; tests pass lowercase keys.
function getterOf(
  headers: Record<string, string | undefined>,
): (name: string) => string | undefined {
  return (name) => headers[name];
}

describe("resolveMemoryScope", () => {
  it("parses all four headers into a fully-populated scope", () => {
    const scope = resolveMemoryScope(
      getterOf({
        "x-thread-id": "thread-1",
        "x-resource-id": "resource-1",
        "x-project-id": "project-1",
        "x-memory-mode": "observe",
      }),
      "acct-a",
    );
    expect(scope).toEqual({
      accountId: "acct-a",
      threadId: "thread-1",
      resourceId: "resource-1",
      projectId: "project-1",
      mode: "observe",
    });
  });

  it("defaults to off + null ids when no headers are present", () => {
    const scope = resolveMemoryScope(getterOf({}), "acct-a");
    expect(scope).toEqual({
      accountId: "acct-a",
      threadId: null,
      resourceId: null,
      projectId: null,
      mode: "off",
    });
  });

  it("normalizes a missing or illegal x-memory-mode to off (default-safe)", () => {
    expect(resolveMemoryScope(getterOf({ "x-thread-id": "t" }), "acct-a").mode).toBe("off");
    expect(resolveMemoryScope(getterOf({ "x-memory-mode": "nonsense" }), "acct-a").mode).toBe(
      "off",
    );
    expect(resolveMemoryScope(getterOf({ "x-memory-mode": "OFF" }), "acct-a").mode).toBe("off");
  });

  it("folds an empty thread-id (and resource/project) to null", () => {
    const scope = resolveMemoryScope(
      getterOf({ "x-thread-id": "", "x-resource-id": "", "x-project-id": "" }),
      "acct-a",
    );
    expect(scope.threadId).toBeNull();
    expect(scope.resourceId).toBeNull();
    expect(scope.projectId).toBeNull();
  });

  it("passes through observe and inject modes", () => {
    expect(resolveMemoryScope(getterOf({ "x-memory-mode": "observe" }), "acct-a").mode).toBe(
      "observe",
    );
    expect(resolveMemoryScope(getterOf({ "x-memory-mode": "inject" }), "acct-a").mode).toBe(
      "inject",
    );
  });
});
