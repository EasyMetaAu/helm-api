import { describe, expect, it, vi } from "vitest";
import type { IRMessage } from "../protocol/ir.js";
import { type InjectBridgeDeps, injectIntoIR, wrapMemoryReminder } from "./inject-bridge.js";
import { sha256Hex } from "./message-hash.js";
import { serializeContent } from "./observe.js";

// docs/08 Phase 2 (#217 Phase 4 TRAILING-REMINDER model) — the framework-agnostic
// bridge that wires the inject assembler onto the IR message array shared by all three
// request surfaces (chat / messages / responses). Under the trailing-reminder model the
// bridge:
//   1. computes the current request's live-window content_hash occurrence counts
//      (the SAME way storage hashes a message) and hands them to the assembler for
//      window-aware dedup;
//   2. keeps the live conversation VERBATIM (tool_calls / images / tool results /
//      developer turns are never destroyed — there is no D7 plain-text gate);
//   3. APPENDS the assembled memory TEXT BLOCK as ONE trailing `<system-reminder>`
//      user turn AFTER the verbatim conversation — the leading system message (and any
//      client cache_control on it) is left byte-identical, so the upstream prompt-cache
//      prefix (tools → system → history) is preserved (cache-preserve revision of
//      decision #3: system-AUTHORITY framing via <system-reminder>, but POSITIONED after
//      the cached prefix instead of at the front of `system`);
//   4. always surfaces the raw `memoryBlock` so the pipeline can splice it natively;
//   5. preserves the "write-back always fires" guarantee for EVERY turn — including
//      the no-memory / degraded / throw paths.

function makeDeps(
  memoryBlock: string | null,
  overrides: Partial<InjectBridgeDeps> = {},
): InjectBridgeDeps {
  return {
    assemble: vi.fn(async () => ({
      memoryBlock,
      metadata: {
        memory_hydrated: memoryBlock !== null,
        reflection_version: 1,
        observation_count: 0,
        facts_injected: 0,
        memory_tokens_injected: memoryBlock !== null ? 10 : 0,
        observer_job_id: "job-1",
        memory_writeback_status: "queued" as const,
        degraded: false,
      },
    })),
    enqueueObserver: vi.fn(async () => ({
      observerJobId: "job-wb",
      status: "queued" as const,
    })),
    now: () => new Date("2026-06-01T00:00:00.000Z"),
    tokenBudget: 4000,
    log: vi.fn(),
    ...overrides,
  };
}

const SCOPE = { accountId: "acct-a", threadId: "t1" } as const;
const BLOCK = "# Persistent memory (injected by helm)\n## Project knowledge\nproj reflection";

// The content_hash the assembler should receive for a string-content message.
const hashOf = (content: IRMessage["content"]): string => sha256Hex(serializeContent(content));

describe("injectIntoIR — trailing-reminder model", () => {
  it("APPENDS a trailing <system-reminder> user turn and keeps the leading system message + all turns verbatim", async () => {
    const deps = makeDeps(BLOCK);
    const original: IRMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "old" },
      { role: "user", content: "hi" },
    ];
    const result = await injectIntoIR(original, "You are helpful.", SCOPE, deps);

    expect(result.memoryBlock).toBe(BLOCK);
    expect(result.metadata?.memory_hydrated).toBe(true);
    // The leading system message is kept BYTE-IDENTICAL (same object) — its cache_control
    // and the upstream cache prefix (system → history) survive untouched.
    expect(result.messages[0]).toBe(original[0]);
    expect(result.messages[1]).toBe(original[1]);
    expect(result.messages[2]).toBe(original[2]);
    // Memory rides ONE trailing <system-reminder> user turn AFTER the conversation.
    expect(result.messages).toHaveLength(4);
    expect(result.messages[3]).toEqual({
      role: "user",
      content: `<system-reminder>\n${BLOCK}\n</system-reminder>`,
    });
    expect(result.messages[3]?.content).toBe(wrapMemoryReminder(BLOCK));
    // The original array is not mutated.
    expect(original).toHaveLength(3);
    expect(original[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("appends the trailing reminder with NO leading system message (none is synthesized)", async () => {
    const deps = makeDeps(BLOCK);
    const original: IRMessage[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: "prior" },
      { role: "user", content: "hi" },
    ];
    const result = await injectIntoIR(original, "", SCOPE, deps);

    expect(result.messages).toHaveLength(4);
    // No system message is invented — the live turns ride verbatim, reminder last.
    expect(result.messages[0]).toBe(original[0]);
    expect(result.messages[1]).toBe(original[1]);
    expect(result.messages[2]).toBe(original[2]);
    expect(result.messages[3]).toEqual({ role: "user", content: wrapMemoryReminder(BLOCK) });
    expect(result.memoryBlock).toBe(BLOCK);
  });

  it("a TOOL turn INJECTS — trailing reminder appended, tool_calls message kept verbatim", async () => {
    const deps = makeDeps(BLOCK);
    const toolCallMsg: IRMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    };
    const toolResultMsg: IRMessage = { role: "tool", content: "out", tool_call_id: "c1" };
    const original: IRMessage[] = [toolCallMsg, toolResultMsg, { role: "user", content: "go on" }];

    const result = await injectIntoIR(original, "", SCOPE, deps);

    // The tool_calls + tool result survive byte-for-byte (same object references).
    expect(result.messages[0]).toBe(toolCallMsg);
    expect(result.messages[1]).toBe(toolResultMsg);
    expect(result.messages[2]).toBe(original[2]);
    expect(result.messages.at(-1)).toEqual({ role: "user", content: wrapMemoryReminder(BLOCK) });
    expect(result.memoryBlock).toBe(BLOCK);
  });

  it("a MULTIMODAL turn INJECTS — multipart content preserved, reminder appended last", async () => {
    const deps = makeDeps(BLOCK);
    const imageMsg: IRMessage = {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ],
    };
    const original: IRMessage[] = [imageMsg];

    const result = await injectIntoIR(original, "", SCOPE, deps);

    expect(result.messages[0]).toBe(imageMsg);
    expect(result.messages[0]?.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", url: "data:image/png;base64,AAAA" },
    ]);
    expect(result.messages.at(-1)).toEqual({ role: "user", content: wrapMemoryReminder(BLOCK) });
  });

  it("passes live-window content_hash occurrence counts (storage-equivalent) to the assembler", async () => {
    const assemble = vi.fn<InjectBridgeDeps["assemble"]>(async () => ({
      memoryBlock: BLOCK,
      metadata: {
        memory_hydrated: true,
        reflection_version: 1,
        observation_count: 0,
        facts_injected: 0,
        memory_tokens_injected: 10,
        observer_job_id: "job-1",
        memory_writeback_status: "queued" as const,
        degraded: false,
      },
    }));
    const deps = makeDeps(BLOCK, { assemble });
    const userMsg: IRMessage = { role: "user", content: "hi there" };
    const assistantMsg: IRMessage = { role: "assistant", content: "hello" };
    const original: IRMessage[] = [userMsg, assistantMsg];

    await injectIntoIR(original, "", SCOPE, deps);

    expect(assemble).toHaveBeenCalledTimes(1);
    const input = assemble.mock.calls[0]?.[0];
    expect(input?.tokenBudget).toBe(4000);
    expect(input?.scope).toEqual(SCOPE);
    const counts = input?.windowContentHashCounts;
    expect(counts).toBeInstanceOf(Map);
    // Hashes match storage's sha256Hex(serializeContent(content)).
    expect(counts?.get(hashOf("hi there"))).toBe(1);
    expect(counts?.get(hashOf("hello"))).toBe(1);
  });

  it("counts repeated live-window content occurrences instead of collapsing them", async () => {
    const assemble = vi.fn<InjectBridgeDeps["assemble"]>(async () => ({
      memoryBlock: BLOCK,
      metadata: {
        memory_hydrated: true,
        reflection_version: 1,
        observation_count: 0,
        facts_injected: 0,
        memory_tokens_injected: 10,
        observer_job_id: "job-1",
        memory_writeback_status: "queued" as const,
        degraded: false,
      },
    }));
    const deps = makeDeps(BLOCK, { assemble });
    await injectIntoIR(
      [
        { role: "user", content: "yes" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "yes" },
      ],
      "",
      SCOPE,
      deps,
    );

    const counts = assemble.mock.calls[0]?.[0]?.windowContentHashCounts;
    expect(counts?.get(hashOf("yes"))).toBe(2);
    expect(counts?.get(hashOf("ok"))).toBe(1);
  });

  it("does not count system/developer turns in the live-window dedup view", async () => {
    const assemble = vi.fn<InjectBridgeDeps["assemble"]>(async () => ({
      memoryBlock: BLOCK,
      metadata: {
        memory_hydrated: true,
        reflection_version: 1,
        observation_count: 0,
        facts_injected: 0,
        memory_tokens_injected: 10,
        observer_job_id: "job-1",
        memory_writeback_status: "queued" as const,
        degraded: false,
      },
    }));
    const deps = makeDeps(BLOCK, { assemble });
    await injectIntoIR(
      [
        { role: "system", content: "same" },
        { role: "developer", content: "same" },
        { role: "user", content: "same" },
      ],
      "same",
      SCOPE,
      deps,
    );

    const counts = assemble.mock.calls[0]?.[0]?.windowContentHashCounts;
    expect(counts?.get(hashOf("same"))).toBe(1);
  });

  it("window-hashes a MULTIPART message via serializeContent (JSON-stringified)", async () => {
    const assemble = vi.fn<InjectBridgeDeps["assemble"]>(async () => ({
      memoryBlock: BLOCK,
      metadata: {
        memory_hydrated: true,
        reflection_version: 1,
        observation_count: 0,
        facts_injected: 0,
        memory_tokens_injected: 10,
        observer_job_id: "job-1",
        memory_writeback_status: "queued" as const,
        degraded: false,
      },
    }));
    const deps = makeDeps(BLOCK, { assemble });
    const multipart: IRMessage = {
      role: "user",
      content: [{ type: "text", text: "now" }],
    };
    await injectIntoIR([multipart], "", SCOPE, deps);

    const counts = assemble.mock.calls[0]?.[0]?.windowContentHashCounts;
    expect(counts?.get(hashOf([{ type: "text", text: "now" }]))).toBe(1);
  });

  it("no-memory: null block → messages UNCHANGED (same array) and block null", async () => {
    const deps = makeDeps(null);
    const original: IRMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const result = await injectIntoIR(original, "sys", SCOPE, deps);

    // Nothing to splice → return the ORIGINAL array reference untouched.
    expect(result.messages).toBe(original);
    expect(result.memoryBlock).toBeNull();
    expect(result.metadata?.memory_hydrated).toBe(false);
  });

  it("fail-open: a degraded assembler result returns the ORIGINAL messages + null block + metadata", async () => {
    const assemble = vi.fn(async () => ({
      memoryBlock: null,
      metadata: {
        memory_hydrated: false,
        reflection_version: null,
        observation_count: 0,
        facts_injected: 0,
        memory_tokens_injected: 0,
        observer_job_id: null,
        memory_writeback_status: "failed" as const,
        degraded: true,
      },
    }));
    const deps = makeDeps(BLOCK, { assemble });
    const original: IRMessage[] = [{ role: "user", content: "hi" }];
    const result = await injectIntoIR(original, "", SCOPE, deps);

    expect(result.messages).toBe(original);
    expect(result.memoryBlock).toBeNull();
    expect(result.metadata?.degraded).toBe(true);
  });

  it("fail-open: an assembler throw returns the ORIGINAL messages + null block + null metadata", async () => {
    const assemble = vi.fn(async () => {
      throw new Error("boom");
    });
    const deps = makeDeps(BLOCK, { assemble });
    const original: IRMessage[] = [{ role: "user", content: "hi" }];
    const result = await injectIntoIR(original, "", SCOPE, deps);

    expect(result.messages).toBe(original);
    expect(result.memoryBlock).toBeNull();
    expect(result.metadata).toBeNull();
    expect(deps.log).toHaveBeenCalled();
  });

  describe("write-back always fires", () => {
    it("does NOT double-enqueue when the assembler ran (assembler owns write-back on inject path)", async () => {
      const deps = makeDeps(BLOCK);
      await injectIntoIR([{ role: "user", content: "hi" }], "", SCOPE, deps);
      // The assembler enqueues write-back internally; the bridge must not enqueue again.
      expect(deps.enqueueObserver).not.toHaveBeenCalled();
    });

    it("does NOT double-enqueue on a degraded result (assembler already enqueued)", async () => {
      const assemble = vi.fn(async () => ({
        memoryBlock: null,
        metadata: {
          memory_hydrated: false,
          reflection_version: null,
          observation_count: 0,
          facts_injected: 0,
          memory_tokens_injected: 0,
          observer_job_id: "wb-degraded",
          memory_writeback_status: "queued" as const,
          degraded: true,
        },
      }));
      const deps = makeDeps(BLOCK, { assemble });
      await injectIntoIR([{ role: "user", content: "hi" }], "", SCOPE, deps);
      expect(deps.enqueueObserver).not.toHaveBeenCalled();
    });

    it("ENQUEUES write-back when the assembler THROWS (preserve write-back-always-fires)", async () => {
      const assemble = vi.fn(async () => {
        throw new Error("boom");
      });
      const deps = makeDeps(BLOCK, { assemble });
      await injectIntoIR([{ role: "user", content: "hi" }], "", SCOPE, deps);
      expect(deps.enqueueObserver).toHaveBeenCalledTimes(1);
      expect(deps.enqueueObserver).toHaveBeenCalledWith(SCOPE);
    });

    it("a throwing enqueueObserver in the catch path is swallowed (still fail-open)", async () => {
      const assemble = vi.fn(async () => {
        throw new Error("boom");
      });
      const enqueueObserver = vi.fn(async () => {
        throw new Error("queue down");
      });
      const deps = makeDeps(BLOCK, { assemble, enqueueObserver });
      const original: IRMessage[] = [{ role: "user", content: "hi" }];
      const result = await injectIntoIR(original, "", SCOPE, deps);
      expect(result.messages).toBe(original);
      expect(result.memoryBlock).toBeNull();
      expect(result.metadata).toBeNull();
    });
  });
});
