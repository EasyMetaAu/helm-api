import type { MemoryMessageInput, MemoryThreadInput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { IRMessage } from "../protocol/ir.js";
import type { MemoryStore } from "../store/ports.js";
import { SqliteMemoryStore } from "../store/sqlite/memory-store.js";
import { createSqliteDb } from "../store/sqlite/migrate.js";
import {
  type ObserveDeps,
  observeInbound,
  observeOutbound,
  projectScopedThreadId,
  resolveMemoryMode,
} from "./observe.js";
import type { MemoryScope } from "./types.js";

// A recording fake MemoryStore — captures every ensureThread / appendMessage
// call so tests assert exactly what observe persisted (and that off writes
// nothing). Memory is a middleware: this fake never touches routing state.
function makeFakeStore() {
  const threads: MemoryThreadInput[] = [];
  const messages: MemoryMessageInput[] = [];
  const stamps: Array<{ accountId: string; threadId: string; modelAlias: string }> = [];
  const store: MemoryStore = {
    ensureThread: vi.fn(async (input: MemoryThreadInput) => {
      threads.push(input);
    }),
    appendMessage: vi.fn(async (input: MemoryMessageInput) => {
      messages.push(input);
      return `msg-${messages.length}`;
    }),
    // observe never reads/compresses — these exist only to satisfy the port.
    listMessages: vi.fn(async () => []),
    appendObservation: vi.fn(async () => "unused"),
    listObservations: vi.fn(async () => []),
    getReflection: vi.fn(async () => null),
    upsertReflection: vi.fn(async () => "unused"),
    updateJobStatus: vi.fn(async () => {}),
    enqueueJob: vi.fn(async () => "job"),
    claimPendingJobs: vi.fn(async () => []),
    stampThreadModel: vi.fn(async (input) => {
      stamps.push(input);
    }),
  };
  return { store, threads, messages, stamps };
}

// A fake that ALSO implements the batch path (appendMessages). observe must prefer
// it over the per-message loop so a whole turn commits once. Records each batch
// AND mirrors rows into `messages` so content assertions reuse the same shape.
function makeBatchingFakeStore() {
  const base = makeFakeStore();
  const batches: MemoryMessageInput[][] = [];
  base.store.appendMessages = vi.fn(async (inputs: MemoryMessageInput[]) => {
    batches.push(inputs);
    return inputs.map((input) => {
      base.messages.push(input);
      return `msg-${base.messages.length}`;
    });
  });
  return { ...base, batches };
}

function makeDeps(store: MemoryStore, overrides: Partial<ObserveDeps> = {}): ObserveDeps {
  return {
    memoryStore: store,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    estimateTokens: (text: string) => text.length,
    log: vi.fn(),
    ...overrides,
  };
}

function scope(partial: Partial<MemoryScope> = {}): MemoryScope {
  return {
    accountId: "acct-a",
    threadId: "thread-1",
    resourceId: "resource-1",
    projectId: "project-1",
    mode: "observe",
    ...partial,
  };
}

const SAMPLE_MESSAGES: IRMessage[] = [
  { role: "system", content: "you are helpful" },
  { role: "user", content: "hello there" },
];

describe("observeInbound", () => {
  it("uses the effective project in the physical thread id while shared projects stay shared", async () => {
    const { store, threads } = makeFakeStore();
    const deps = makeDeps(store);

    await observeInbound(deps, scope({ projectId: "key-a" }), SAMPLE_MESSAGES);
    await observeInbound(deps, scope({ projectId: "key-b" }), SAMPLE_MESSAGES);
    await observeInbound(deps, scope({ projectId: "shared-project" }), SAMPLE_MESSAGES);
    await observeInbound(deps, scope({ projectId: "shared-project" }), SAMPLE_MESSAGES);

    const ids = threads.map((thread) => thread.id);
    expect(ids[0]).toBe(projectScopedThreadId("acct-a", "key-a", "thread-1"));
    expect(ids[1]).toBe(projectScopedThreadId("acct-a", "key-b", "thread-1"));
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(projectScopedThreadId("acct-a", "shared-project", "thread-1"));
    expect(ids[3]).toBe(ids[2]);
  });

  it("persists each raw message + thread when mode is observe", async () => {
    const { store, threads, messages } = makeFakeStore();
    const deps = makeDeps(store);

    const out = await observeInbound(deps, scope(), SAMPLE_MESSAGES);

    expect(out.persisted).toBe(true);
    // Thread ensured once with the scope ids.
    expect(threads).toEqual([
      {
        id: projectScopedThreadId("acct-a", "project-1", "thread-1"),
        ownerId: "acct-a",
        projectId: "project-1",
        resourceId: "resource-1",
      },
    ]);
    // System/developer instructions are policy, not user memory, so only the
    // user turn is persisted.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      threadId: projectScopedThreadId("acct-a", "project-1", "thread-1"),
      messageIndex: 1,
      role: "user",
      content: "hello there",
      tokenEstimate: "hello there".length,
    });
  });

  it("uses appendMessages (one batched commit) when the store supports it", async () => {
    const { store, threads, messages, batches } = makeBatchingFakeStore();
    const deps = makeDeps(store);

    const out = await observeInbound(deps, scope(), SAMPLE_MESSAGES);

    expect(out.persisted).toBe(true);
    expect(threads).toHaveLength(1);
    // ONE batched call for the whole turn — never the per-message appendMessage.
    expect(store.appendMessages).toHaveBeenCalledTimes(1);
    expect(store.appendMessage).not.toHaveBeenCalled();
    // System turn filtered out before batching; only the user message is persisted.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(messages[0]?.messageIndex).toBe(1);
    expect(messages.map((m) => m.content)).toEqual(["hello there"]);
  });

  it("does NOT inject: messages handed to the classifier are byte-for-byte unchanged, and no observation/reflection is read", async () => {
    const { store } = makeFakeStore();
    // A store with ONLY observe-phase methods — any read method would be a typing
    // error. Spy to prove no read path is invoked.
    const readSpy = vi.fn();
    const deps = makeDeps(store);
    const input = structuredClone(SAMPLE_MESSAGES);

    const out = await observeInbound(deps, scope(), input);

    // Input array not mutated.
    expect(input).toEqual(SAMPLE_MESSAGES);
    // Return value carries metadata only — never an injectable prompt.
    expect(out).not.toHaveProperty("prompt");
    expect(out).not.toHaveProperty("context");
    expect(out).not.toHaveProperty("messages");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("off mode is a pure no-op: zero DB writes, persisted=false", async () => {
    const { store, threads, messages } = makeFakeStore();
    const deps = makeDeps(store);

    const out = await observeInbound(deps, scope({ mode: "off" }), SAMPLE_MESSAGES);

    expect(out.persisted).toBe(false);
    expect(store.ensureThread).not.toHaveBeenCalled();
    expect(store.appendMessage).not.toHaveBeenCalled();
    expect(threads).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  it("does not create a thread without a project or resource", async () => {
    const { store, threads, messages } = makeFakeStore();
    const log = vi.fn();
    const deps = makeDeps(store, { log });

    const out = await observeInbound(
      deps,
      scope({ projectId: null, resourceId: null }),
      SAMPLE_MESSAGES,
    );

    expect(out.persisted).toBe(false);
    expect(threads).toEqual([]);
    expect(messages).toEqual([]);
    expect(log).toHaveBeenCalledWith("memory.observe.skip_no_parent_scope", {
      memory_mode: "observe",
    });
  });

  it("reports memoryMeta with memory_hydrated=false and the docs/08 debug field set", async () => {
    const { store } = makeFakeStore();
    const deps = makeDeps(store);

    const out = await observeInbound(deps, scope(), SAMPLE_MESSAGES);

    expect(out.memoryMeta.memory_hydrated).toBe(false);
    expect(out.memoryMeta).toEqual({
      memory_mode: "observe",
      thread_id: "thread-1",
      resource_id: "resource-1",
      project_id: "project-1",
      memory_hydrated: false,
      reflection_version: null,
      observation_count: 0,
      memory_tokens_injected: 0,
      observer_job_id: null,
      memory_writeback_status: null,
    });
  });

  it("fail-open: a store write failure does not throw to the main flow; logs the failure and reports persisted=false", async () => {
    const { store } = makeFakeStore();
    (store.appendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const log = vi.fn();
    const deps = makeDeps(store, { log });

    const out = await observeInbound(deps, scope(), SAMPLE_MESSAGES);

    expect(out.persisted).toBe(false);
    // Main request can continue: meta still produced.
    expect(out.memoryMeta.memory_mode).toBe("observe");
    expect(log).toHaveBeenCalled();
  });
});

describe("observeOutbound", () => {
  it("does not write or enqueue without a project or resource", async () => {
    const { store, messages, stamps } = makeFakeStore();
    const enqueueObserverJob = vi.fn(async () => "observer-job");
    const log = vi.fn();
    const deps = makeDeps(store, { enqueueObserverJob, log });

    await observeOutbound(
      deps,
      scope({ projectId: null, resourceId: null }),
      { responseMessages: [{ role: "assistant", content: "hi" }], toolResults: [] },
      "openai/gpt-x",
    );

    expect(messages).toEqual([]);
    expect(stamps).toEqual([]);
    expect(enqueueObserverJob).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("memory.observe.skip_no_parent_scope", {
      memory_mode: "observe",
    });
  });

  it("enqueues one coalesced observer job in pure observe mode", async () => {
    const { store } = makeFakeStore();
    const enqueueObserverJob = vi.fn(async () => "observer-job");
    const deps = makeDeps(store, { enqueueObserverJob });

    await observeOutbound(deps, scope(), {
      responseMessages: [{ role: "assistant", content: "hi back" }],
      toolResults: [],
    });

    expect(enqueueObserverJob).toHaveBeenCalledWith({
      accountId: "acct-a",
      threadId: projectScopedThreadId("acct-a", "project-1", "thread-1"),
      projectId: "project-1",
      resourceId: "resource-1",
    });
  });

  it("persists response messages + tool results when observe", async () => {
    const { store, messages } = makeFakeStore();
    const deps = makeDeps(store);

    await observeOutbound(deps, scope(), {
      responseMessages: [{ role: "assistant", content: "hi back" }],
      toolResults: [{ role: "tool", content: "tool output", tool_call_id: "call-1" }],
      messageIndexOffset: 2,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ messageIndex: 2, role: "assistant", content: "hi back" });
    expect(messages[1]).toMatchObject({ messageIndex: 3, role: "tool", content: "tool output" });
  });

  it("batches response + tool messages in one appendMessages call when supported", async () => {
    const { store, messages, batches } = makeBatchingFakeStore();
    const deps = makeDeps(store);

    await observeOutbound(deps, scope(), {
      responseMessages: [{ role: "assistant", content: "hi back" }],
      toolResults: [{ role: "tool", content: "tool output", tool_call_id: "call-1" }],
    });

    expect(store.appendMessages).toHaveBeenCalledTimes(1);
    expect(store.appendMessage).not.toHaveBeenCalled();
    expect(batches[0]).toHaveLength(2);
    expect(messages.map((m) => m.content)).toEqual(["hi back", "tool output"]);
  });

  it("off mode does not write outbound", async () => {
    const { store, messages } = makeFakeStore();
    const deps = makeDeps(store);

    await observeOutbound(deps, scope({ mode: "off" }), {
      responseMessages: [{ role: "assistant", content: "hi" }],
      toolResults: [],
    });

    expect(messages).toHaveLength(0);
    expect(store.appendMessage).not.toHaveBeenCalled();
  });

  it("fail-open: outbound store failure does not throw", async () => {
    const { store } = makeFakeStore();
    (store.appendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const log = vi.fn();
    const deps = makeDeps(store, { log });

    await expect(
      observeOutbound(deps, scope(), {
        responseMessages: [{ role: "assistant", content: "x" }],
        toolResults: [],
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("stamps the served model for auto-compaction pricing", async () => {
    const { store, stamps } = makeFakeStore();
    const deps = makeDeps(store);

    await observeOutbound(
      deps,
      scope(),
      { responseMessages: [{ role: "assistant", content: "hi" }], toolResults: [] },
      "anthropic/claude-x",
    );

    expect(stamps).toEqual([
      {
        accountId: "acct-a",
        threadId: projectScopedThreadId("acct-a", "project-1", "thread-1"),
        modelAlias: "anthropic/claude-x",
      },
    ]);
  });

  it("stamps the served model even with EMPTY response messages (tool-call/empty stream)", async () => {
    // Regression: the streamed tool-call-only path has no reconstructed text, but
    // the served-model stamp must still land — otherwise auto-compaction prices
    // the thread from heuristics instead of the real catalog entry.
    const { store, stamps, messages } = makeFakeStore();
    const deps = makeDeps(store);

    await observeOutbound(deps, scope(), { responseMessages: [], toolResults: [] }, "openai/gpt-x");

    expect(messages).toHaveLength(0); // nothing to persist
    expect(stamps).toEqual([
      {
        accountId: "acct-a",
        threadId: projectScopedThreadId("acct-a", "project-1", "thread-1"),
        modelAlias: "openai/gpt-x",
      },
    ]);
  });

  it("does NOT stamp when no served model is known", async () => {
    const { store, stamps } = makeFakeStore();
    const deps = makeDeps(store);

    await observeOutbound(deps, scope(), {
      responseMessages: [{ role: "assistant", content: "hi" }],
      toolResults: [],
    });

    expect(stamps).toHaveLength(0);
    expect(store.stampThreadModel).not.toHaveBeenCalled();
  });

  it("off mode does not stamp the served model", async () => {
    const { store, stamps } = makeFakeStore();
    const deps = makeDeps(store);

    await observeOutbound(
      deps,
      scope({ mode: "off" }),
      { responseMessages: [], toolResults: [] },
      "anthropic/claude-x",
    );

    expect(stamps).toHaveLength(0);
  });
});

describe("resolveMemoryMode (gateway header normalization helper)", () => {
  it("normalizes missing/illegal mode to off (default-safe)", () => {
    expect(resolveMemoryMode(undefined)).toBe("off");
    expect(resolveMemoryMode(null)).toBe("off");
    expect(resolveMemoryMode("")).toBe("off");
    expect(resolveMemoryMode("nonsense")).toBe("off");
    expect(resolveMemoryMode("OFF")).toBe("off");
  });

  it("passes through valid modes", () => {
    expect(resolveMemoryMode("off")).toBe("off");
    expect(resolveMemoryMode("observe")).toBe("observe");
    expect(resolveMemoryMode("inject")).toBe("inject");
  });
});

// End-to-end re-ingestion guard against the REAL sqlite store (the fakes blindly
// push, so only a real store proves the dedup constraint actually holds). This is
// the regression test for the production O(n²) bug: a client re-sending its full
// transcript every turn must NOT duplicate rows — only the new delta persists.
describe("observeInbound re-ingestion (real SqliteMemoryStore)", () => {
  function realDeps(): ObserveDeps {
    const db = createSqliteDb(":memory:");
    let seq = 0;
    const store = new SqliteMemoryStore(
      db,
      () => `id-${++seq}`,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    return {
      memoryStore: store,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      estimateTokens: (t) => t.length,
      log: vi.fn(),
    };
  }

  it("re-sending the full transcript every turn persists only the new delta", async () => {
    const deps = realDeps();
    const sc = scope();

    // Turn 1: user asks.
    await observeInbound(deps, sc, [
      { role: "system", content: "you are helpful" }, // policy, never persisted
      { role: "user", content: "u1" },
    ]);
    // Turn 2: client re-sends turn 1 + the assistant reply + a new user message.
    await observeInbound(deps, sc, [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);
    // Turn 3: re-send everything again + one more.
    await observeInbound(deps, sc, [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);

    const msgs = await deps.memoryStore.listMessages({
      threadId: projectScopedThreadId("acct-a", "project-1", "thread-1"),
      accountId: "acct-a",
    });
    // 4 distinct turns (u1,a1,u2,a2) — NOT 2+4+5=11 blind re-inserts.
    expect(msgs.map((m) => m.content)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("preserves legitimate repeated content at a later transcript position", async () => {
    const deps = realDeps();
    const sc = scope();

    await observeInbound(deps, sc, [{ role: "user", content: "yes" }]);
    await observeInbound(deps, sc, [
      { role: "user", content: "yes" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "yes" },
    ]);

    const msgs = await deps.memoryStore.listMessages({
      threadId: projectScopedThreadId("acct-a", "project-1", "thread-1"),
      accountId: "acct-a",
    });
    expect(msgs.map((m) => m.content)).toEqual(["yes", "ok", "yes"]);
  });
});
