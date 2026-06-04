import type { AssembledMessage } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { IRMessage } from "../protocol/ir.js";
import { type InjectBridgeDeps, injectIntoIR, isPlainTextTurn } from "./inject-bridge.js";

// docs/08 Phase 2 — the framework-agnostic bridge that wires the inject assembler
// onto the IR message array shared by all three request surfaces. Covers the D7
// plain-text gate, D8 RawMessage synthesis + source → IR restoration, strict order
// preservation, and the fail-open boundary.

function makeDeps(
  messages: AssembledMessage[],
  overrides: Partial<InjectBridgeDeps> = {},
): InjectBridgeDeps {
  return {
    assemble: vi.fn(async () => ({
      messages,
      metadata: {
        memory_hydrated: true,
        reflection_version: 1,
        observation_count: messages.filter((m) => m.source === "thread_observation").length,
        memory_tokens_injected: 10,
        observer_job_id: "job-1",
        memory_writeback_status: "queued" as const,
        degraded: false,
      },
    })),
    now: () => new Date("2026-06-01T00:00:00.000Z"),
    tokenBudget: 4000,
    log: vi.fn(),
    ...overrides,
  };
}

describe("isPlainTextTurn (D7 gate)", () => {
  it("accepts a plain text user turn", () => {
    expect(isPlainTextTurn([{ role: "user", content: "hi" }])).toBe(true);
  });

  it("rejects a turn carrying tool_calls", () => {
    const m: IRMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    };
    expect(isPlainTextTurn([m])).toBe(false);
  });

  it("rejects a turn with a tool result message", () => {
    expect(isPlainTextTurn([{ role: "tool", content: "out", tool_call_id: "c1" }])).toBe(false);
  });

  it("rejects multipart / structured content", () => {
    const m: IRMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
    expect(isPlainTextTurn([m])).toBe(false);
  });
});

describe("injectIntoIR", () => {
  const ASSEMBLED: AssembledMessage[] = [
    { role: "user", content: "sys", source: "system" },
    { role: "user", content: "proj reflection", source: "project_reflection" },
    { role: "user", content: "obs", source: "thread_observation" },
    { role: "user", content: "earlier", source: "recent_raw" },
    { role: "user", content: "hi", source: "current" },
  ];

  it("maps the assembled prefix back to IR, restoring system source to role=system, in order", async () => {
    const deps = makeDeps(ASSEMBLED);
    const result = await injectIntoIR(
      [{ role: "user", content: "hi" }],
      "sys",
      { accountId: "acct-a", threadId: "t1" },
      deps,
    );
    expect(result.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "proj reflection" },
      { role: "user", content: "obs" },
      { role: "user", content: "earlier" },
      { role: "user", content: "hi" },
    ]);
  });

  it("synthesizes a Zod-valid RawMessage for the current turn (threadId placeholder when absent)", async () => {
    const assemble = vi.fn(async () => ({
      messages: ASSEMBLED,
      metadata: {
        memory_hydrated: true,
        reflection_version: null,
        observation_count: 0,
        memory_tokens_injected: 0,
        observer_job_id: null,
        memory_writeback_status: "skipped" as const,
        degraded: false,
      },
    }));
    const deps = makeDeps(ASSEMBLED, { assemble });
    await injectIntoIR([{ role: "user", content: "hi" }], "sys", { accountId: "acct-a" }, deps);
    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        // RawMessageSchema requires threadId.min(1); absent scope.threadId → placeholder.
        currentUserMessage: expect.objectContaining({
          threadId: expect.stringMatching(/.+/),
          role: "user",
          content: "hi",
        }),
      }),
    );
  });

  it("returns the metadata from the assembler", async () => {
    const deps = makeDeps(ASSEMBLED);
    const result = await injectIntoIR(
      [{ role: "user", content: "hi" }],
      "sys",
      { accountId: "acct-a", threadId: "t1" },
      deps,
    );
    expect(result.metadata).not.toBeNull();
    expect(result.metadata?.memory_hydrated).toBe(true);
    expect(result.metadata?.observer_job_id).toBe("job-1");
  });

  it("fail-open: a degraded assembler result returns the ORIGINAL messages unchanged + metadata", async () => {
    const assemble = vi.fn(async () => ({
      messages: [
        { role: "user" as const, content: "sys", source: "system" as const },
        { role: "user" as const, content: "current", source: "current" as const },
      ],
      metadata: {
        memory_hydrated: false,
        reflection_version: null,
        observation_count: 0,
        memory_tokens_injected: 0,
        observer_job_id: null,
        memory_writeback_status: "failed" as const,
        degraded: true,
      },
    }));
    const deps = makeDeps(ASSEMBLED, { assemble });
    const original: IRMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "prior" },
      { role: "user", content: "current" },
    ];
    const result = await injectIntoIR(
      original,
      "sys",
      { accountId: "acct-a", threadId: "t1" },
      deps,
    );
    expect(result.messages).toBe(original);
    expect(result.metadata?.degraded).toBe(true);
  });

  it("fail-open: an assembler throw returns the ORIGINAL messages unchanged + null metadata", async () => {
    const assemble = vi.fn(async () => {
      throw new Error("boom");
    });
    const deps = makeDeps(ASSEMBLED, { assemble });
    const original: IRMessage[] = [{ role: "user", content: "hi" }];
    const result = await injectIntoIR(
      original,
      "sys",
      { accountId: "acct-a", threadId: "t1" },
      deps,
    );
    expect(result.messages).toBe(original);
    expect(result.metadata).toBeNull();
  });

  it("collapses an assistant source row to role=assistant (not system)", async () => {
    const assembled: AssembledMessage[] = [
      { role: "user", content: "sys", source: "system" },
      { role: "assistant", content: "prior reply", source: "recent_raw" },
      { role: "user", content: "hi", source: "current" },
    ];
    const deps = makeDeps(assembled);
    const result = await injectIntoIR(
      [{ role: "user", content: "hi" }],
      "sys",
      { accountId: "acct-a", threadId: "t1" },
      deps,
    );
    expect(result.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "assistant", content: "prior reply" },
      { role: "user", content: "hi" },
    ]);
  });
});
