import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedOAuthFetch } from "./refresh-fetch.js";

afterEach(() => vi.useRealTimers());

describe("bounded OAuth fetch", () => {
  it("aborts a transport that ignores its signal and cancels a late response", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const cancelled = vi.fn();
    let signal: AbortSignal | null | undefined;
    const transport: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((r) => {
        resolve = r;
      });
    };
    const result = boundedOAuthFetch(transport, 100)("https://example.test");
    const rejected = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(signal?.aborted).toBe(true);
    resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled body even when stream cancellation never resolves", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    const transport: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
          },
          cancel: cancelled,
        }),
      );
    const response = await boundedOAuthFetch(transport, 100)("https://example.test");
    const rejected = expect(response.json()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps caller cancellation and response metadata and clears completed timers", async () => {
    vi.useFakeTimers();
    const transport: typeof fetch = async () =>
      new Response('{"ok":true}', {
        status: 201,
        headers: { "x-test": "yes" },
      });
    const response = await boundedOAuthFetch(transport, 100)("https://example.test");
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("yes");
    expect(await response.json()).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    const caller = new AbortController();
    caller.abort(new Error("caller stopped"));
    await expect(
      boundedOAuthFetch(transport)("https://example.test", { signal: caller.signal }),
    ).rejects.toThrow("caller stopped");
  });
});
