import type { InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { CircuitBreaker } from "../circuit/breaker.js";
import {
  type Candidate,
  type FallbackDeps,
  InvokeFailure,
  type ProviderResult,
  runFallback,
} from "./fallback.js";

// executor.fallback — traverse the ordered candidate chain (primary →
// fallback[]). Per CLAUDE.md principle 5, this is EXECUTION fallback (swap the
// model WITHIN the chain), never CLASSIFICATION fallback (→ balanced). Principle
// 3: it is the ONLY anchor where a structured error (`all_providers_failed`) may
// be produced, and only when the WHOLE chain is exhausted. Ports llm-router
// semantics (explicit skip reasons, `:free` 429 skip, abort = non-fault)
// WITHOUT importing it. See task executor.fallback, docs/02, docs/07.

function makeRequest(): InternalRequest {
  return {
    request_id: "req-1",
    protocol: "openai_chat",
    account_id: "acct-1",
    api_key_id: "key-1",
    user_id: null,
    org_id: null,
    requested_model: "balanced",
    messages: [{ role: "user", content: "hi" }],
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
  };
}

// A fully-permissive breaker test double whose individual methods are spies so
// tests can assert exactly which record* / canAttempt calls happened.
function makeBreaker(
  overrides: Partial<Record<keyof CircuitBreaker, unknown>> = {},
): CircuitBreaker {
  return {
    canAttempt: vi.fn(() => ({ allow: true, probe: false })),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
    recordAbort: vi.fn(),
    getState: vi.fn(() => "CLOSED"),
    ...overrides,
  } as unknown as CircuitBreaker;
}

function okResult(overrides: Partial<ProviderResult> = {}): ProviderResult {
  return { error_class: null, cost_usd: 0.01, ...overrides };
}

let clock = 0;
function makeDeps(overrides: Partial<FallbackDeps> = {}): FallbackDeps {
  clock = 0;
  return {
    breaker: makeBreaker(),
    checkCapability: () => ({ ok: true }),
    invoke: async () => okResult(),
    now: () => {
      clock += 5;
      return clock;
    },
    ...overrides,
  };
}

const PRIMARY: Candidate = { alias: "primary", providerModel: "gpt-4o" };
const FALLBACK: Candidate = { alias: "fb", providerModel: "claude-3-5" };

describe("runFallback", () => {
  it("1. primary success — returns final.ok at primary, single attempt, never touches fallback", async () => {
    const invoke = vi.fn(async (c: Candidate) =>
      okResult({ cost_usd: c.alias === "primary" ? 0.02 : 0 }),
    );
    const deps = makeDeps({ invoke });
    const out = await runFallback(
      [PRIMARY, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") {
      expect(out.final.alias).toBe("primary");
      expect(out.final.providerModel).toBe("gpt-4o");
    }
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]?.status).toBe("ok");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("2. primary fails before first chunk → fallback takes over", async () => {
    const invoke = vi.fn(async (c: Candidate) => {
      if (c.alias === "primary") throw new InvokeFailure({ error_class: "upstream_error" });
      return okResult();
    });
    const breaker = makeBreaker();
    const deps = makeDeps({ invoke, breaker });
    const out = await runFallback(
      [PRIMARY, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("fb");
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0]).toMatchObject({
      alias: "primary",
      status: "error",
      error_class: "upstream_error",
    });
    expect(out.attempts[1]).toMatchObject({ alias: "fb", status: "ok" });
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(breaker.recordFailure).toHaveBeenCalledWith("gpt-4o");
  });

  it("3. skips OPEN — canAttempt.allow=false records circuit_open skip, never invokes primary", async () => {
    const canAttempt = vi.fn((model: string) =>
      model === "gpt-4o"
        ? { allow: false, probe: false, reason: "circuit_open" }
        : { allow: true, probe: false },
    );
    const breaker = makeBreaker({ canAttempt });
    const invoke = vi.fn(async () => okResult());
    const deps = makeDeps({ breaker, invoke });
    const out = await runFallback(
      [PRIMARY, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    expect(out.attempts[0]).toMatchObject({
      alias: "primary",
      skipped: true,
      skip_reason: "circuit_open",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(FALLBACK, expect.anything(), expect.anything());
    expect(out.final.status).toBe("ok");
  });

  it("4. skips incompatible candidate — checkCapability ok:false → capability:<reason> skip", async () => {
    const checkCapability = vi.fn((c: Candidate) =>
      c.alias === "primary" ? { ok: false, skipReason: "capability:json" } : { ok: true },
    );
    const invoke = vi.fn(async () => okResult());
    const deps = makeDeps({ checkCapability, invoke });
    const out = await runFallback(
      [PRIMARY, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    expect(out.attempts[0]).toMatchObject({
      alias: "primary",
      skipped: true,
      skip_reason: "capability:json",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(FALLBACK, expect.anything(), expect.anything());
  });

  it("5. whole chain exhausted → all_providers_failed (502), every candidate covered", async () => {
    const invoke = vi.fn(async () => {
      throw new InvokeFailure({ error_class: "upstream_error" });
    });
    const deps = makeDeps({ invoke });
    const out = await runFallback(
      [PRIMARY, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("all_providers_failed");
      expect(out.final.error.http_status).toBe(502);
    }
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts.map((a) => a.alias)).toEqual(["primary", "fb"]);
    expect(out.attempts.every((a) => a.status === "error")).toBe(true);
  });

  it("6. per-attempt records are complete — every decision.provider_attempts field present", async () => {
    const invoke = vi.fn(async () => okResult({ cost_usd: 0.03 }));
    const deps = makeDeps({ invoke });
    const out = await runFallback([PRIMARY], makeRequest(), deps, new AbortController().signal);

    const a = out.attempts[0];
    expect(a).toBeDefined();
    expect(a).toEqual(
      expect.objectContaining({
        alias: expect.any(String),
        skipped: expect.any(Boolean),
        status: expect.stringMatching(/^(ok|error)$/),
        latency_ms: expect.any(Number),
      }),
    );
    // nullable fields present (may be null) — keys must exist for the schema.
    expect(a).toHaveProperty("skip_reason");
    expect(a).toHaveProperty("error_class");
    expect(a).toHaveProperty("cost_usd");
    expect(a?.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("7. HALF_OPEN probe success records success", async () => {
    const canAttempt = vi.fn(() => ({ allow: true, probe: true }));
    const breaker = makeBreaker({ canAttempt });
    const invoke = vi.fn(async () => okResult());
    const deps = makeDeps({ breaker, invoke });
    const out = await runFallback([PRIMARY], makeRequest(), deps, new AbortController().signal);

    expect(breaker.recordSuccess).toHaveBeenCalledWith("gpt-4o");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("primary");
  });

  it("8. client abort aborts the WHOLE chain and is a non-fault", async () => {
    const invoke = vi.fn(async () => {
      throw new InvokeFailure({ error_class: "upstream_error", aborted: true });
    });
    const breaker = makeBreaker();
    const deps = makeDeps({ invoke, breaker });
    const out = await runFallback(
      [PRIMARY, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    expect(breaker.recordAbort).toHaveBeenCalledWith("gpt-4o");
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    // abort terminates the chain: fallback is NOT attempted.
    expect(invoke).toHaveBeenCalledTimes(1);
    // not all_providers_failed — abort is its own client_abort class (499), so
    // telemetry never miscounts a disconnect as an upstream fault (review fix #4).
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("client_abort");
      expect(out.final.error.http_status).toBe(499);
    }
  });

  it("9. `:free` candidate 429 is skipped (free_429), no breaker failure, next candidate tried", async () => {
    const free: Candidate = { alias: "free_model:free", providerModel: "llama:free" };
    const invoke = vi.fn(async (c: Candidate) => {
      if (c.alias === "free_model:free")
        throw new InvokeFailure({ error_class: "rate_limited", status: 429 });
      return okResult();
    });
    const breaker = makeBreaker();
    const deps = makeDeps({ invoke, breaker });
    const out = await runFallback(
      [free, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    expect(out.attempts[0]).toMatchObject({
      alias: "free_model:free",
      skipped: true,
      skip_reason: "free_429",
    });
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("fb");
  });

  it("10. order preserved — strictly [primary, ...fallback], */auto not hoisted", async () => {
    const a: Candidate = { alias: "openai/auto", providerModel: "auto-x" };
    const order: string[] = [];
    const invoke = vi.fn(async (c: Candidate) => {
      order.push(c.alias);
      throw new InvokeFailure({ error_class: "upstream_error" });
    });
    const deps = makeDeps({ invoke });
    const out = await runFallback(
      [PRIMARY, a, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    expect(order).toEqual(["primary", "openai/auto", "fb"]);
    expect(out.attempts.map((x) => x.alias)).toEqual(["primary", "openai/auto", "fb"]);
  });

  it("11. empty chain → lane_unavailable (503), distinct from all_providers_failed", async () => {
    const deps = makeDeps();
    const out = await runFallback([], makeRequest(), deps, new AbortController().signal);

    expect(out.attempts).toHaveLength(0);
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("lane_unavailable");
      expect(out.final.error.http_status).toBe(503);
    }
  });

  it("12. fail-open — a thrown checkCapability degrades to skipping that candidate, never 5xx mid-chain", async () => {
    const checkCapability = vi.fn((c: Candidate) => {
      if (c.alias === "primary") throw new Error("capability subsystem boom");
      return { ok: true };
    });
    const invoke = vi.fn(async () => okResult());
    const deps = makeDeps({ checkCapability, invoke });
    const out = await runFallback(
      [PRIMARY, FALLBACK],
      makeRequest(),
      deps,
      new AbortController().signal,
    );

    // degraded: primary skipped, fallback served — no crash, no all_providers_failed.
    expect(out.attempts[0]).toMatchObject({ alias: "primary", skipped: true });
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("fb");
  });
});
