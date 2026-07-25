import type { CircuitBreaker, ProviderClient } from "@helm/core";
import { UpstreamError } from "@helm/core";
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

  it("falls back to the next provider when the primary fails (breaker fault on primary)", async () => {
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValueOnce(new UpstreamError("upstream_error", "boom", null, 500))
      .mockResolvedValueOnce(okResult(0.02));
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, signal);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.served.alias).toBe("b"); // fell over to the fallback
    expect(breaker.recordFailure).toHaveBeenCalledWith("a");
    expect(breaker.recordSuccess).toHaveBeenCalledWith("b");
    // failed row then served row
    expect(res.attempts.map((a) => a.status)).toEqual(["error", "ok"]);
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

  it("a client abort is terminal: recordAbort, no fault, aborted flag set", async () => {
    const ac = new AbortController();
    ac.abort();
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, ac.signal);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected terminal");
    expect(res.aborted).toBe(true);
    expect(res.errorClass).toBe("client_abort");
    expect(breaker.recordAbort).toHaveBeenCalledWith("a");
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it.each([
    "openai",
    "gemini",
  ] as const)("lease loss is terminal 503 for the production %s image chain without fallback or breaker fault", async (kind) => {
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
    expect(res.errorClass).toBe("lane_unavailable");
    expect(res.httpStatus).toBe(503);
    expect(res.attempts[0]).toMatchObject({
      alias: "primary",
      skip_reason: "concurrency_lease_lost",
      error_class: "lane_unavailable",
    });
    expect(breaker.recordAbort).toHaveBeenCalledWith("primary");
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
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
  ])("%s exhausts the chain as all_providers_failed (502)", async (_name, error) => {
    const breaker = fakeBreaker();
    const attempt: ImageAttempt = vi.fn().mockRejectedValue(error);
    const res = await runImageChain([target("a"), target("b")], breaker, attempt, signal);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected terminal");
    expect(res.errorClass).toBe("all_providers_failed");
    expect(res.httpStatus).toBe(502);
    expect(breaker.recordFailure).toHaveBeenCalledTimes(2);
    expect(res.attempts.map((a) => a.status)).toEqual(["error", "error"]);
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
