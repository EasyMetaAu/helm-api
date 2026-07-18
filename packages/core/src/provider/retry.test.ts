import { describe, expect, it, vi } from "vitest";
import { isFetchTransportError, isTransientConnectionError, withConnectionRetry } from "./retry.js";

// A transient connection error is one safe to retry BEFORE any bytes reached the
// client (idempotent: no upstream response consumed). The classifier is a strict
// allowlist — only raw socket/connection signatures match, so an already-classified
// UpstreamError (timeout / non-2xx) or a client AbortError falls through to false.

describe("isTransientConnectionError", () => {
  const transient: Array<[string, unknown]> = [
    ["ECONNRESET code", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    [
      "ECONNREFUSED code",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    ],
    ["EPIPE code", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })],
    ["ETIMEDOUT code", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })],
    [
      "UND_ERR_SOCKET code",
      Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    ],
    ["undici 'terminated'", new Error("terminated")],
    ["node 'socket hang up'", new Error("socket hang up")],
    [
      "Bun socket-closed text",
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
    ],
    ["undici 'Premature close'", new Error("Premature close")],
    [
      "undici 'fetch failed' wrapping a SocketError cause",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
    ],
  ];
  it.each(transient)("treats %s as transient", (_label, err) => {
    expect(isTransientConnectionError(err)).toBe(true);
  });

  const nonTransient: Array<[string, unknown]> = [
    ["AbortError name", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["DOMException abort", new DOMException("This operation was aborted", "AbortError")],
    ["UpstreamError(timeout) message", new Error("upstream request timed out")],
    ["upstream non-2xx message", new Error("upstream returned 500")],
    ["unrelated error", new Error("totally unrelated")],
    ["null", null],
    ["undefined", undefined],
    ["string", "boom"],
  ];
  it.each(nonTransient)("treats %s as non-transient", (_label, err) => {
    expect(isTransientConnectionError(err)).toBe(false);
  });

  it("does not retry an abort even if its message looks transient", () => {
    // Defense in depth: a client abort that happens to carry a socket-ish message
    // must still be classified non-transient (name wins).
    const err = Object.assign(new Error("socket hang up"), { name: "AbortError" });
    expect(isTransientConnectionError(err)).toBe(false);
  });
});

describe("isFetchTransportError", () => {
  it("classifies an opaque undici fetch failure even when its cause code is not retry-allowlisted", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Connect Timeout Error"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });

    expect(isTransientConnectionError(err)).toBe(false);
    expect(isFetchTransportError(err)).toBe(true);
  });

  it("does not classify an abort or an already-classified timeout as a raw fetch transport error", () => {
    expect(
      isFetchTransportError(new DOMException("This operation was aborted", "AbortError")),
    ).toBe(false);
    expect(isFetchTransportError(new Error("upstream request timed out"))).toBe(false);
  });
});

describe("withConnectionRetry", () => {
  const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

  it("retries a transient error then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw reset();
      return "ok";
    });
    const sleep = vi.fn(async () => {});
    const result = await withConnectionRetry(fn, { retries: 2, sleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("upstream returned 400");
    });
    await expect(withConnectionRetry(fn, { retries: 2, sleep: async () => {} })).rejects.toThrow(
      "400",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts the retry budget then throws the last transient error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(withConnectionRetry(fn, { retries: 2, sleep: async () => {} })).rejects.toThrow(
      "socket hang up",
    );
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2
  });

  it("stops immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn(async () => {
      throw reset();
    });
    await expect(
      withConnectionRetry(fn, { retries: 2, sleep: async () => {}, signal: ac.signal }),
    ).rejects.toThrow("ECONNRESET");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops retrying if the signal aborts during backoff", async () => {
    const ac = new AbortController();
    const fn = vi.fn(async () => {
      throw reset();
    });
    // The abort lands while we are sleeping between attempts.
    const sleep = vi.fn(async () => {
      ac.abort();
    });
    await expect(withConnectionRetry(fn, { retries: 3, sleep, signal: ac.signal })).rejects.toThrow(
      "ECONNRESET",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("defaults to 2 retries with no opts", async () => {
    const fn = vi.fn(async () => {
      throw reset();
    });
    await expect(withConnectionRetry(fn, { sleep: async () => {} })).rejects.toThrow("ECONNRESET");
    expect(fn).toHaveBeenCalledTimes(3); // default retries = 2
  });
});
