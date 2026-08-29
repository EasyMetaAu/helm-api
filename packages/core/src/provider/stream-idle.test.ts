import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IdleReadResult, readChunkWithIdle, StreamStalledError } from "./stream-idle.js";

// stream-idle — the inter-chunk liveness guard for the provider SSE readers. Once
// a stream's headers arrive the connect/TTFB timeout is cleared (see provider
// withTimeout), so WITHOUT this a wedged upstream that stops mid-stream hangs
// forever. readChunkWithIdle races a single reader.read() against an idle
// deadline: a chunk in time passes through; silence past the deadline cancels the
// reader (reclaim the connection) and throws StreamStalledError, which the client
// maps to UpstreamError("timeout"). Each call owns a fresh timer, so the deadline
// is PER-CHUNK silence, never a total-stream cap (a long stream that keeps
// emitting runs unbounded). idleMs <= 0 disables the guard (plain read).

type ReadResult = IdleReadResult<Uint8Array>;

function fakeReader(reads: Array<() => Promise<ReadResult>>) {
  let i = 0;
  const cancelReasons: unknown[] = [];
  return {
    cancelReasons,
    read: (): Promise<ReadResult> => (reads[i++] ?? (() => new Promise<ReadResult>(() => {})))(),
    cancel: async (reason?: unknown): Promise<void> => {
      cancelReasons.push(reason);
    },
  };
}

const chunk = (s: string): ReadResult => ({ done: false, value: new TextEncoder().encode(s) });
const END: ReadResult = { done: true, value: undefined };

describe("readChunkWithIdle", () => {
  it("returns the chunk when read resolves before the idle deadline", async () => {
    const reader = fakeReader([() => Promise.resolve(chunk("hi"))]);
    const out = await readChunkWithIdle(reader, 1000);
    expect(out.done).toBe(false);
    expect(new TextDecoder().decode(out.value)).toBe("hi");
    expect(reader.cancelReasons).toHaveLength(0);
  });

  it("passes a terminal done result through unchanged", async () => {
    const reader = fakeReader([() => Promise.resolve(END)]);
    const out = await readChunkWithIdle(reader, 1000);
    expect(out.done).toBe(true);
  });

  it("idleMs <= 0 disables the guard: a slow read still resolves, no timer, no cancel", async () => {
    let resolve!: (r: ReadResult) => void;
    const reader = fakeReader([() => new Promise<ReadResult>((r) => (resolve = r))]);
    const p = readChunkWithIdle(reader, 0);
    resolve(chunk("late"));
    const out = await p;
    expect(new TextDecoder().decode(out.value)).toBe("late");
    expect(reader.cancelReasons).toHaveLength(0);
  });

  it("cancels a pending read when the caller aborts", async () => {
    const reader = fakeReader([() => new Promise<ReadResult>(() => {})]);
    const controller = new AbortController();
    const pending = readChunkWithIdle(reader, 0, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(reader.cancelReasons).toHaveLength(1);
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("throws StreamStalledError and cancels the reader when silence passes the deadline", async () => {
      // A read that never resolves -> the idle deadline must win.
      const reader = fakeReader([() => new Promise<ReadResult>(() => {})]);
      const p = readChunkWithIdle(reader, 500);
      const assertion = expect(p).rejects.toBeInstanceOf(StreamStalledError);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      expect(reader.cancelReasons).toHaveLength(1);
      expect(reader.cancelReasons[0]).toBeInstanceOf(StreamStalledError);
    });

    it("does not fire when each chunk arrives within the per-chunk deadline (timer resets per call)", async () => {
      // Two sequential reads, each resolving just under the 500ms deadline; the
      // cumulative 800ms must NOT trip the guard because each call gets a fresh timer.
      const reader = fakeReader([
        () => new Promise<ReadResult>((r) => setTimeout(() => r(chunk("a")), 400)),
        () => new Promise<ReadResult>((r) => setTimeout(() => r(chunk("b")), 400)),
      ]);
      const p1 = readChunkWithIdle(reader, 500);
      await vi.advanceTimersByTimeAsync(400);
      expect(new TextDecoder().decode((await p1).value)).toBe("a");
      const p2 = readChunkWithIdle(reader, 500);
      await vi.advanceTimersByTimeAsync(400);
      expect(new TextDecoder().decode((await p2).value)).toBe("b");
      expect(reader.cancelReasons).toHaveLength(0);
    });
  });
});
