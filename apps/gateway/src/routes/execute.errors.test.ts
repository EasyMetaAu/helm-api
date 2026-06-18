import type { CircuitBreaker, ExecutionPlan, ProviderClient, ProviderRegistry } from "@helm/core";
import { createCircuitBreaker, UpstreamError } from "@helm/core";
import type { CatalogEntry, InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createExecute } from "./execute.js";

// Supplemental error/edge coverage for the gateway execution adapter. Pins the
// branches execute.test.ts leaves open: the per-account user-message queue-timeout
// (backpressure, NOT provider health → terminal lane_unavailable, no breaker
// failure), the capability_unsatisfiable terminal (every candidate pruned by the
// capability filter), the array/primitive provider_raw wrapping in error_detail,
// and the empty-chain lane_unavailable terminal. Behavior-only (CLAUDE.md
// principle 5 — the two fallback kinds stay distinct).

function req(over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-1",
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content: "hello" }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: null,
    stream: false,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
    ...over,
  };
}

function registry(map: Record<string, string>): ProviderRegistry {
  return {
    resolve(alias: string) {
      const pm = map[alias];
      if (pm === undefined) return { ok: false, error: { kind: "unknown_alias", alias } };
      return {
        ok: true,
        value: {
          alias,
          providerName: "mock",
          providerModel: pm,
          baseUrl: "http://x",
          apiKeyEnv: "X",
          targetProviderProtocol: "openai_chat",
          providerRequiresCompatibilityRewrite: false,
        },
      };
    },
    list: () => Object.keys(map),
  };
}

function plan(chain: string[]): ExecutionPlan {
  return { selected_lane: "balanced", candidate_chain: chain, explicit_model: null };
}

function breaker(): CircuitBreaker {
  return createCircuitBreaker({ config: { failureThreshold: 5, cooldownMs: 1000 }, now: () => 0 });
}

function clock() {
  let t = 0;
  return () => (t += 10);
}

// A no-tools capability entry (mirrors execute.test.ts): a tools-requiring request
// is pruned by checkCapability → skip_reason no_tool_support.
function noToolsEntry(modelKey: string): CatalogEntry {
  return {
    modelKey,
    capabilities: {
      supportsTools: false,
      jsonOutput: "schema",
      supportsVision: true,
      supportsStreaming: true,
      maxContextTokens: 100000,
      maxOutputTokens: 4096,
    },
    pricing: {
      inputPerMTokUsd: null,
      outputPerMTokUsd: null,
      cacheReadPerMTokUsd: null,
      cacheWritePerMTokUsd: null,
    },
    source: "generated",
  };
}

describe("createExecute — user-message queue timeout (issue #93 feature B)", () => {
  it("terminates the chain with lane_unavailable on a queue timeout, no breaker failure, no chain advance", async () => {
    // A QueueTimeoutError is detected by the `queueTimeout` flag (not instanceof).
    const queueErr = Object.assign(new Error("user message queue wait timed out"), {
      queueTimeout: true,
    });
    const provider = {
      chatCompletion: vi.fn().mockRejectedValue(queueErr),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const recordAbort = vi.spyOn(cb, "recordAbort");
    // A second candidate that WOULD serve — it must never be reached (terminal).
    const secondProvider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;

    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("lane_unavailable");
      expect(out.final.error.message).toContain("queue");
    }
    // BACKPRESSURE, not a provider-health signal: a probe lock is released via
    // recordAbort, NEVER recordFailure; and the chain does NOT advance to `b`.
    expect(recordAbort).toHaveBeenCalledWith("a");
    expect(recordFailure).not.toHaveBeenCalled();
    expect(secondProvider.chatCompletion).not.toHaveBeenCalled();
    // The terminal attempt row carries the queue-timeout skip reason.
    expect(out.attempts.at(-1)?.skip_reason).toBe("user_message_queue_timeout");
    expect(out.attempts.at(-1)?.error_class).toBe("lane_unavailable");
  });
});

describe("createExecute — capability_unsatisfiable terminal", () => {
  it("returns capability_unsatisfiable (422) when EVERY candidate is capability-pruned", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "never" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breaker(),
      // BOTH candidates lack tool support; the request needs tools → both pruned.
      catalog: new Map([
        ["a", noToolsEntry("a")],
        ["b", noToolsEntry("b")],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req({ tools: [{ type: "function" }] }));

    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      // No candidate was attempted AND ≥1 was capability-pruned AND none was merely
      // circuit-open → the hard-constraint terminal, not all_providers_failed.
      expect(out.final.error.error_class).toBe("capability_unsatisfiable");
      expect(out.final.error.message).toContain("capability");
    }
    // The provider was never invoked (every candidate skipped before the upstream).
    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(out.attempts.every((a) => a.skipped)).toBe(true);
  });
});

describe("createExecute — empty candidate chain", () => {
  it("returns lane_unavailable (503) for an empty candidate chain", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({}),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan([]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("lane_unavailable");
      expect(out.final.error.message).toContain("no candidates");
    }
    expect(out.attempts).toHaveLength(0);
  });
});

describe("createExecute — circuit-open skip is transient (not capability_unsatisfiable)", () => {
  it("skips an OPEN-breaker candidate (circuit_open) and serves the next; a pure-circuit-skip terminal stays all_providers_failed", async () => {
    // A breaker that is OPEN for `a` but allows `b`. The first candidate is skipped
    // with skip_reason circuit_open (circuitSkipped=true), then `b` is attempted.
    const breakerStub: CircuitBreaker = {
      canAttempt: (alias: string) =>
        alias === "a" ? { allow: false, reason: "circuit_open" } : { allow: true, reason: null },
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordAbort: vi.fn(),
    } as unknown as CircuitBreaker;
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "from-b" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breakerStub,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());

    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("circuit_open");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("b");
  });

  it("a chain where the only non-attempted skip is circuit-open terminates all_providers_failed (transient), never capability_unsatisfiable", async () => {
    // Both candidates' breakers are OPEN → every candidate is circuit-skipped, none
    // capability-pruned. The terminal must be the TRANSIENT all_providers_failed
    // (retryable), NOT capability_unsatisfiable (a hard, non-retryable constraint).
    const breakerStub: CircuitBreaker = {
      canAttempt: () => ({ allow: false, reason: "circuit_open" }),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordAbort: vi.fn(),
    } as unknown as CircuitBreaker;
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breakerStub,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("all_providers_failed");
    }
    expect(provider.chatCompletion).not.toHaveBeenCalled();
  });
});

describe("createExecute — error_detail provider_raw wrapping", () => {
  it("wraps a non-object provider_raw (array) into { raw } in the attempt error_detail", async () => {
    // An UpstreamError carrying an ARRAY providerRaw (e.g. a scrubbed text/HTML
    // error page) must be preserved, not dropped — toRawRecord wraps it as { raw }.
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValue(
          new UpstreamError("upstream_error", "bad gateway", ["line1", "line2"], 502),
        ),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a"]), req());

    expect(out.final.status).toBe("error");
    const detail = out.attempts[0]?.error_detail;
    expect(detail?.upstream_status).toBe(502);
    // The array providerRaw was wrapped under a `raw` key (object|null schema shape).
    expect(detail?.provider_raw).toEqual({ raw: ["line1", "line2"] });
  });

  it("preserves an object provider_raw verbatim in the attempt error_detail", async () => {
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValue(
          new UpstreamError("upstream_error", "boom", { code: "x", detail: "y" }, 500),
        ),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a"]), req());
    const detail = out.attempts[0]?.error_detail;
    expect(detail?.provider_raw).toEqual({ code: "x", detail: "y" });
  });
});
