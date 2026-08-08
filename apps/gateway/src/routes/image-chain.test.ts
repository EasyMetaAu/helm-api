import type { CircuitBreaker, ProviderClient } from "@helm/core";
import { createCircuitBreaker, UpstreamError } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { type ImageAttempt, type ImageChainTarget, runImageChain } from "./image-chain.js";

// A breaker double: every alias CLOSED unless listed in `open`. Records calls so a
// test can assert recordSuccess/recordFailure/recordAbort landed on the right alias.
function fakeBreaker(open: Set<string> = new Set()): CircuitBreaker {
  return {
    canAttempt: (m: string) =>
      open.has(m)
        ? { allow: false, probe: false, reason: "circuit_open" }
        : { allow: true, probe: false },
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordAbort: vi.fn(),
  } as unknown as CircuitBreaker;
}

const client = {} as unknown as ProviderClient;
function target(alias: string, kind: "openai" | "gemini" = "openai"): ImageChainTarget {
  return { alias, providerModel: `wire/${alias}`, kind, client };
}

// A successful attempt result the route would build from the served upstream body.
function okResult(cost: number | null = 0.01) {
  return {
    clientBody: { data: [{ b64_json: "IMG" }] },
    usage: { input_tokens: 1, output_tokens: 2 },
    cost,
    upstreamRequestJson: "{}",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("runImageChain", () => {
  const signal = new AbortController().signal;

  it("serves the primary when healthy; records success on it only", async () => {
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi.fn().mockResolvedValue(okResult(0.05));
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, signal);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.served.alias).toBe("a");
    expect(res.result.cost).toBe(0.05);
    expect(attempt).toHaveBeenCalledTimes(1); // never touched the fallback
    expect(breaker.recordSuccess).toHaveBeenCalledWith("a");
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    // one served row, cost on it
    expect(res.attempts).toHaveLength(1);
    expect(res.attempts[0]?.status).toBe("ok");
    expect(res.attempts[0]?.cost_usd).toBe(0.05);
  });

  it("returns outcome_unknown without replaying a paid image write on another provider", async () => {
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValueOnce(new UpstreamError("upstream_error", "boom", null, 500))
      .mockResolvedValueOnce(okResult(0.02));
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, signal);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected terminal");
    expect(res.errorClass).toBe("outcome_unknown");
    expect(res.httpStatus).toBe(503);
    expect(breaker.recordFailure).toHaveBeenCalledWith("a");
    expect(breaker.recordSuccess).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(res.attempts.map((a) => a.status)).toEqual(["error"]);
    expect(res.attempts[0]?.skipped).toBe(false);
    expect(res.attempts[0]?.cost_usd).toBeNull();
  });

  it("skips a breaker-OPEN primary (no fault) and serves the next", async () => {
    const breaker = fakeBreaker(new Set(["a"]));
    const attempt: ImageAttempt = vi.fn().mockResolvedValue(okResult());
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, signal);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.served.alias).toBe("b");
    expect(attempt).toHaveBeenCalledTimes(1); // primary never attempted
    expect(breaker.recordFailure).not.toHaveBeenCalledWith("a"); // OPEN skip ≠ fault
    expect(res.attempts[0]).toMatchObject({
      alias: "a",
      skipped: true,
      skip_reason: "circuit_open",
    });
    expect(res.attempts[1]?.status).toBe("ok");
  });

  it("a 4xx invalid_request is terminal: no fallback, no breaker fault, verbatim", async () => {
    const breaker = fakeBreaker();
    const raw = { error: { type: "invalid_request_error", message: "image too large" } };
    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValue(new UpstreamError("upstream_error", "bad", raw, 400));
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, signal);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected terminal");
    expect(res.errorClass).toBe("invalid_request");
    expect(res.httpStatus).toBe(400);
    expect(res.providerRaw).toEqual(raw); // surfaced verbatim
    expect(attempt).toHaveBeenCalledTimes(1); // did NOT advance to the fallback
    expect(breaker.recordFailure).not.toHaveBeenCalled(); // request is wrong, upstream is healthy
  });

  it("does not let a stale invalid_request release another request's HALF_OPEN probe", async () => {
    let now = 0;
    const breaker = createCircuitBreaker({
      config: { failureThreshold: 5, cooldownMs: 1000 },
      now: () => now,
    });
    const stale = deferred<Awaited<ReturnType<ImageAttempt>>>();
    const probe = deferred<Awaited<ReturnType<ImageAttempt>>>();

    const staleRun = runImageChain([target("a")], breaker, () => stale.promise, signal);
    for (let i = 0; i < 5; i += 1) breaker.recordFailure("a");
    expect(breaker.getState("a")).toBe("OPEN");

    now = 1000;
    const probeAttempt: ImageAttempt = vi.fn().mockReturnValue(probe.promise);
    const probeRun = runImageChain([target("a")], breaker, probeAttempt, signal);
    expect(probeAttempt).toHaveBeenCalledTimes(1);
    expect(breaker.getState("a")).toBe("HALF_OPEN");

    stale.reject(
      new UpstreamError(
        "upstream_error",
        "bad request",
        { error: { type: "invalid_request_error", message: "image too large" } },
        400,
      ),
    );
    const staleResult = await staleRun;
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) expect(staleResult.errorClass).toBe("invalid_request");
    expect(breaker.canAttempt("a")).toEqual({
      allow: false,
      probe: false,
      reason: "circuit_open",
    });

    probe.resolve(okResult());
    expect((await probeRun).ok).toBe(true);
    expect(breaker.getState("a")).toBe("CLOSED");
  });

  it("releases its own HALF_OPEN probe on invalid_request", async () => {
    let now = 0;
    const breaker = createCircuitBreaker({
      config: { failureThreshold: 5, cooldownMs: 1000 },
      now: () => now,
    });
    for (let i = 0; i < 5; i += 1) breaker.recordFailure("a");
    now = 1000;

    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValue(
        new UpstreamError(
          "upstream_error",
          "bad request",
          { error: { type: "invalid_request_error", message: "image too large" } },
          400,
        ),
      );
    const first = await runImageChain([target("a")], breaker, attempt, signal);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.errorClass).toBe("invalid_request");
    expect(breaker.getState("a")).toBe("HALF_OPEN");

    const second = await runImageChain(
      [target("a")],
      breaker,
      vi.fn().mockResolvedValue(okResult()),
      signal,
    );
    expect(second.ok).toBe(true);
    expect(breaker.getState("a")).toBe("CLOSED");
  });

  it("a ZenMux invalid_params 400 is terminal with the upstream message", async () => {
    const breaker = fakeBreaker();
    const raw = {
      error: {
        code: "400",
        type: "invalid_params",
        message: "Unknown parameter: 'response_format'.",
      },
    };
    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValue(new UpstreamError("upstream_error", "upstream returned 400", raw, 400));

    const res = await runImageChain([target("a"), target("b")], breaker, attempt, signal);

    expect(res).toMatchObject({
      ok: false,
      errorClass: "invalid_request",
      httpStatus: 400,
      message: "Unknown parameter: 'response_format'.",
      providerRaw: raw,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it("a client abort after media execution starts is outcome_unknown and remains observable", async () => {
    const ac = new AbortController();
    ac.abort();
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, ac.signal);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected terminal");
    expect(res.aborted).toBe(false);
    expect(res.errorClass).toBe("outcome_unknown");
    expect(res.httpStatus).toBe(503);
    expect(breaker.recordAbort).toHaveBeenCalledWith("a");
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it.each([
    "openai",
    "gemini",
  ] as const)("lease loss after media execution starts is outcome_unknown for the %s image chain", async (kind) => {
    const ac = new AbortController();
    ac.abort("concurrency_lease_lost");
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("lease lost"), { name: "AbortError" }));

    const res = await runImageChain(
      [target("primary", kind), target("fallback", kind)],
      breaker,
      attempt,
      ac.signal,
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected terminal");
    expect(res.aborted).toBe(false);
    expect(res.errorClass).toBe("outcome_unknown");
    expect(res.httpStatus).toBe(503);
    expect(res.attempts[0]).toMatchObject({
      alias: "primary",
      skip_reason: "concurrency_lease_lost",
      error_class: "outcome_unknown",
    });
    expect(breaker.recordAbort).toHaveBeenCalledWith("primary");
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("a request timeout after media execution starts is outcome_unknown", async () => {
    const ac = new AbortController();
    ac.abort("request_timeout");
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("timed out"), { name: "AbortError" }));

    const res = await runImageChain([target("a"), target("b")], breaker, attempt, ac.signal);

    expect(res).toMatchObject({
      ok: false,
      aborted: false,
      errorClass: "outcome_unknown",
      httpStatus: 503,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(breaker.recordAbort).toHaveBeenCalledWith("a");
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it.each([
    ["provider 401", new UpstreamError("upstream_error", "unauthorized", null, 401)],
    ["provider 403", new UpstreamError("upstream_error", "forbidden", null, 403)],
    [
      "provider 404 invalid_model",
      new UpstreamError(
        "upstream_error",
        "upstream returned 404",
        { error: { code: "404", type: "invalid_model", message: "Requested model is not valid" } },
        404,
      ),
    ],
    ["provider 429", new UpstreamError("upstream_error", "rate limited", null, 429)],
    ["provider 500", new UpstreamError("upstream_error", "boom", null, 500)],
    ["network error", new TypeError("fetch failed")],
  ])("%s becomes outcome_unknown without replaying the POST", async (_name, error) => {
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi.fn().mockRejectedValue(error);
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, signal);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected terminal");
    expect(res.errorClass).toBe("outcome_unknown");
    expect(res.httpStatus).toBe(503);
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(res.attempts.map((a) => a.status)).toEqual(["error"]);
  });

  it("an empty target list → lane_unavailable (503)", async () => {
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi.fn();
    const res = await runImageChain([], breaker, attempt, signal);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected terminal");
    expect(res.errorClass).toBe("lane_unavailable");
    expect(res.httpStatus).toBe(503);
    expect(attempt).not.toHaveBeenCalled();
  });
});
