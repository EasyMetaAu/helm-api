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
      threadSource: "header",
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
      threadSource: null,
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

// Per-key memory defaults (issue #97): clients that can only send STATIC headers
// (Claude Code / Codex) — or none at all — get memory via server-side key config.
// Explicit headers always win; an unconfigured key behaves exactly as before.
describe("resolveMemoryScope — per-key defaults (issue #97)", () => {
  const DEFAULTS = { mode: "inject", projectId: "proj-key", threadSource: "header" } as const;

  it("falls back to the key's memory defaults when the headers are absent", () => {
    const scope = resolveMemoryScope(getterOf({}), "acct-a", { defaults: DEFAULTS });
    expect(scope.mode).toBe("inject");
    expect(scope.projectId).toBe("proj-key");
  });

  it("explicit headers always override the key defaults", () => {
    const scope = resolveMemoryScope(
      getterOf({ "x-memory-mode": "observe", "x-project-id": "proj-header" }),
      "acct-a",
      { defaults: DEFAULTS },
    );
    expect(scope.mode).toBe("observe");
    expect(scope.projectId).toBe("proj-header");
  });

  it("an explicit x-memory-mode: off wins over a key default of inject", () => {
    const scope = resolveMemoryScope(getterOf({ "x-memory-mode": "off" }), "acct-a", {
      defaults: DEFAULTS,
    });
    expect(scope.mode).toBe("off");
  });

  it("no defaults provided = exactly the old behavior (zero regression)", () => {
    const scope = resolveMemoryScope(getterOf({}), "acct-a");
    expect(scope.mode).toBe("off");
    expect(scope.projectId).toBeNull();
    expect(scope.threadId).toBeNull();
  });
});

// Thread signal fallback chain (issue #97): when the key opts in via
// memory_thread_source=auto, the thread anchor is derived from signals the
// client ALREADY sends — body metadata, the x-session-key header, OpenAI's
// prompt_cache_key (OpenClaw/Codex), Anthropic's metadata.user_id (Claude
// Code/OpenClaw) — in a fixed priority order. An explicit x-thread-id always wins.
describe("resolveMemoryScope — thread signal fallback chain (issue #97)", () => {
  const AUTO = { mode: "inject", projectId: null, threadSource: "auto" } as const;
  const ALL_SIGNALS = {
    metadataThreadId: "meta-thread",
    promptCacheKey: "cache-key-1",
    metadataUserId: "anthropic-user-1",
  };

  it("explicit x-thread-id always wins over every signal", () => {
    const scope = resolveMemoryScope(
      getterOf({ "x-thread-id": "explicit", "x-session-key": "sess-1" }),
      "acct-a",
      { defaults: AUTO, signals: ALL_SIGNALS },
    );
    expect(scope.threadId).toBe("explicit");
    expect(scope.threadSource).toBe("header");
  });

  it("derives the thread from signals in priority order: metadata > session-key > prompt_cache_key > metadata.user_id", () => {
    // 1) body metadata thread id wins over everything else
    let scope = resolveMemoryScope(getterOf({ "x-session-key": "sess-1" }), "acct-a", {
      defaults: AUTO,
      signals: ALL_SIGNALS,
    });
    expect(scope.threadId).toBe("meta-thread");
    expect(scope.threadSource).toBe("metadata_thread_id");

    // 2) then the x-session-key header
    scope = resolveMemoryScope(getterOf({ "x-session-key": "sess-1" }), "acct-a", {
      defaults: AUTO,
      signals: { promptCacheKey: "cache-key-1", metadataUserId: "anthropic-user-1" },
    });
    expect(scope.threadId).toBe("sess-1");
    expect(scope.threadSource).toBe("session_key");

    // 3) then prompt_cache_key (OpenClaw / Codex)
    scope = resolveMemoryScope(getterOf({}), "acct-a", {
      defaults: AUTO,
      signals: { promptCacheKey: "cache-key-1", metadataUserId: "anthropic-user-1" },
    });
    expect(scope.threadId).toBe("cache-key-1");
    expect(scope.threadSource).toBe("prompt_cache_key");

    // 4) finally Anthropic metadata.user_id (Claude Code)
    scope = resolveMemoryScope(getterOf({}), "acct-a", {
      defaults: AUTO,
      signals: { metadataUserId: "anthropic-user-1" },
    });
    expect(scope.threadId).toBe("anthropic-user-1");
    expect(scope.threadSource).toBe("metadata_user_id");
  });

  it("does NOT derive from signals when thread_source=header (default; zero regression)", () => {
    const scope = resolveMemoryScope(getterOf({ "x-session-key": "sess-1" }), "acct-a", {
      defaults: { mode: "inject", projectId: null, threadSource: "header" },
      signals: ALL_SIGNALS,
    });
    expect(scope.threadId).toBeNull();
    expect(scope.threadSource).toBeNull();
  });

  it("no signals and no header -> thread stays null (writeback skipped downstream)", () => {
    const scope = resolveMemoryScope(getterOf({}), "acct-a", { defaults: AUTO, signals: {} });
    expect(scope.threadId).toBeNull();
    expect(scope.threadSource).toBeNull();
  });

  it("empty-string signals never fabricate a thread id", () => {
    const scope = resolveMemoryScope(getterOf({ "x-session-key": "" }), "acct-a", {
      defaults: AUTO,
      signals: { metadataThreadId: "", promptCacheKey: "", metadataUserId: "" },
    });
    expect(scope.threadId).toBeNull();
  });
});
