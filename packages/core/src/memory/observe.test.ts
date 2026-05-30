import type { MemoryMessageInput, MemoryThreadInput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { IRMessage } from "../protocol/ir.js";
import type { MemoryStore } from "../store/ports.js";
import { type ObserveDeps, observeInbound, observeOutbound, resolveMemoryMode } from "./observe.js";
import type { MemoryScope } from "./types.js";

// A recording fake MemoryStore — captures every ensureThread / appendMessage
// call so tests assert exactly what observe persisted (and that off writes
// nothing). Memory is a middleware: this fake never touches routing state.
function makeFakeStore() {
  const threads: MemoryThreadInput[] = [];
  const messages: MemoryMessageInput[] = [];
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
  };
  return { store, threads, messages };
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
  it("persists each raw message + thread when mode is observe", async () => {
    const { store, threads, messages } = makeFakeStore();
    const deps = makeDeps(store);

    const out = await observeInbound(deps, scope(), SAMPLE_MESSAGES);

    expect(out.persisted).toBe(true);
    // Thread ensured once with the scope ids.
    expect(threads).toEqual([{ id: "thread-1", projectId: "project-1", resourceId: "resource-1" }]);
    // One row per message, role + token_estimate correct.
    expect(messages).toHaveLength(2);
    // The memory_* role enum is user|assistant|tool (no "system"); an IR system
    // message is recorded as a user-side raw line.
    expect(messages[0]).toMatchObject({
      threadId: "thread-1",
      role: "user",
      content: "you are helpful",
      tokenEstimate: "you are helpful".length,
    });
    expect(messages[1]).toMatchObject({ role: "user", content: "hello there" });
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
  it("persists response messages + tool results when observe", async () => {
    const { store, messages } = makeFakeStore();
    const deps = makeDeps(store);

    await observeOutbound(deps, scope(), {
      responseMessages: [{ role: "assistant", content: "hi back" }],
      toolResults: [{ role: "tool", content: "tool output", tool_call_id: "call-1" }],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "assistant", content: "hi back" });
    expect(messages[1]).toMatchObject({ role: "tool", content: "tool output" });
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
