import type { EvalConfig } from "@helm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CircuitOpenError,
  type EvalClientDeps,
  type EvalLogEvent,
  type EvalModelRequest,
  type EvalModelResponse,
  runEval,
} from "./client.js";

// eval.client — `runEval` actually calls the internal small model to judge a
// request's lane. It MUST: send a non-streaming, temperature:0, max_tokens-capped
// request; forward config.timeout_ms to invokeModel as the PER-CANDIDATE deadline
// (executor-enforced fallback) and guard the whole call with the outer_timeout_ms
// consumer race; and NEVER throw — any timeout / provider error / circuit-open /
// parse failure collapses to `{ decided:false, reason }` so eval.cascade fails
// open to balanced (CLAUDE.md principles 3, 4, 7). Logs/telemetry must never carry
// plaintext prompt, user messages, or raw model output (principle 7).

const SECRET_USER_MSG = "TOP-SECRET-USER-PROMPT-payload-do-not-log";
const SECRET_MODEL_TEXT = '{"complexity":"complex","task_type":"coding","confidence":0.9}';

function makeConfig(over: Partial<EvalConfig> = {}): EvalConfig {
  return {
    enabled: true,
    model: "deepseek/deepseek-v4-flash",
    temperature: 0,
    max_tokens: 256,
    timeout_ms: 300,
    outer_timeout_ms: 250,
    on_failure: "balanced",
    cache: {
      enabled: true,
      key: "content_hash",
      ttl_sec: 300,
      max_entries: 5000,
    },
    ...over,
  };
}

// Generic classifier input — runEval only forwards it to buildPrompt and never
// inspects it, so a minimal shape is enough for the client's contract.
const INPUT = { messages: [{ role: "user", content: SECRET_USER_MSG }] };

function makeDeps(
  over: Partial<EvalClientDeps<typeof INPUT>> = {},
): EvalClientDeps<typeof INPUT> & { logs: EvalLogEvent[] } {
  const logs: EvalLogEvent[] = [];
  let t = 1000;
  return {
    config: makeConfig(),
    invokeModel: vi.fn(async (): Promise<EvalModelResponse> => ({ text: SECRET_MODEL_TEXT })),
    buildPrompt: (input): EvalModelRequest["messages"] => [
      { role: "system", content: "classify" },
      { role: "user", content: String(input.messages[0]?.content ?? "") },
    ],
    now: () => {
      t += 5;
      return t;
    },
    log: (e) => {
      logs.push(e);
    },
    logs,
    ...over,
  };
}

function firstCall<T>(calls: readonly T[]): T {
  const call = calls[0];
  if (call === undefined) {
    throw new Error("expected the mock to have at least one call");
  }
  return call;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runEval", () => {
  it("returns a decision on a valid model response (test 1)", async () => {
    const deps = makeDeps();
    const result = await runEval(INPUT, deps);
    expect(result.decided).toBe(true);
    if (result.decided) {
      expect(result.output).toEqual({
        complexity: "complex",
        task_type: "coding",
        confidence: 0.9,
      });
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("forces temperature:0, stream:false, max_tokens cap on the request (test 2)", async () => {
    const invokeModel = vi.fn(
      async (_req: EvalModelRequest, _signal: AbortSignal): Promise<EvalModelResponse> => ({
        text: SECRET_MODEL_TEXT,
      }),
    );
    const deps = makeDeps({
      config: makeConfig({ max_tokens: 128 }),
      invokeModel,
    });
    await runEval(INPUT, deps);
    expect(invokeModel).toHaveBeenCalledTimes(1);
    const [req, signal] = firstCall(invokeModel.mock.calls);
    expect(req.temperature).toBe(0);
    expect(req.stream).toBe(false);
    expect(req.max_tokens).toBe(128);
    expect(req.model).toBe("deepseek/deepseek-v4-flash");
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards config.extra_body onto the request verbatim (provider passthrough)", async () => {
    const invokeModel = vi.fn(
      async (_req: EvalModelRequest, _signal: AbortSignal): Promise<EvalModelResponse> => ({
        text: SECRET_MODEL_TEXT,
      }),
    );
    const deps = makeDeps({
      config: makeConfig({ extra_body: { thinking: { type: "disabled" } } }),
      invokeModel,
    });
    await runEval(INPUT, deps);
    const [req] = firstCall(invokeModel.mock.calls);
    expect(req.extra_body).toEqual({ thinking: { type: "disabled" } });
  });

  it("omits extra_body on the request when none is configured", async () => {
    const invokeModel = vi.fn(
      async (_req: EvalModelRequest, _signal: AbortSignal): Promise<EvalModelResponse> => ({
        text: SECRET_MODEL_TEXT,
      }),
    );
    const deps = makeDeps({ invokeModel });
    await runEval(INPUT, deps);
    const [req] = firstCall(invokeModel.mock.calls);
    expect(req.extra_body).toBeUndefined();
  });

  it("forwards config.timeout_ms to invokeModel as the per-candidate attempt deadline (test 3)", async () => {
    // timeout_ms is no longer a local inner race; it is the PER-CANDIDATE budget the
    // loopback hands to the executor so a slow head model falls back to the next
    // candidate (breaker fault + advance) instead of aborting the whole eval.
    let capturedAttemptMs: number | undefined;
    const deps = makeDeps({
      config: makeConfig({ timeout_ms: 3000, outer_timeout_ms: 10_000 }),
      invokeModel: vi.fn(
        async (
          _req: EvalModelRequest,
          _signal: AbortSignal,
          attemptTimeoutMs: number,
        ): Promise<EvalModelResponse> => {
          capturedAttemptMs = attemptTimeoutMs;
          return { text: SECRET_MODEL_TEXT };
        },
      ),
    });
    const result = await runEval(INPUT, deps);
    expect(capturedAttemptMs).toBe(3000);
    expect(result.decided).toBe(true);
  });

  it("outer timeout guards the total budget (test 4)", async () => {
    // A loopback that never resolves (e.g. every candidate wedged) must still fail open
    // when the TOTAL outer budget elapses, never hanging the hot path.
    const deps = makeDeps({
      config: makeConfig({ timeout_ms: 10_000, outer_timeout_ms: 250 }),
      invokeModel: vi.fn(() => new Promise<EvalModelResponse>(() => {})),
    });
    const p = runEval(INPUT, deps);
    await vi.advanceTimersByTimeAsync(251);
    const result = await p;
    expect(result.decided).toBe(false);
    if (!result.decided) {
      expect(result.reason).toBe("timeout");
    }
  });

  it("provider error fails open without throwing (test 5)", async () => {
    const deps = makeDeps({
      invokeModel: vi.fn(async () => {
        throw new Error("upstream 503");
      }),
    });
    const result = await runEval(INPUT, deps);
    expect(result.decided).toBe(false);
    if (!result.decided) {
      expect(result.reason).toBe("provider_error");
    }
  });

  it("circuit-open error maps to circuit_open reason (test 6)", async () => {
    const deps = makeDeps({
      invokeModel: vi.fn(async () => {
        throw new CircuitOpenError("breaker open");
      }),
    });
    const result = await runEval(INPUT, deps);
    expect(result.decided).toBe(false);
    if (!result.decided) {
      expect(result.reason).toBe("circuit_open");
    }
  });

  it("non-JSON model output fails open as not_json (test 7a)", async () => {
    const deps = makeDeps({
      invokeModel: vi.fn(async (): Promise<EvalModelResponse> => ({ text: "sorry, I cannot" })),
    });
    const result = await runEval(INPUT, deps);
    expect(result.decided).toBe(false);
    if (!result.decided) {
      expect(result.reason).toBe("not_json");
    }
  });

  it("invalid-enum model output fails open as schema_invalid (test 7b)", async () => {
    const deps = makeDeps({
      invokeModel: vi.fn(
        async (): Promise<EvalModelResponse> => ({
          text: '{"complexity":"galaxy","task_type":"coding","confidence":0.9}',
        }),
      ),
    });
    const result = await runEval(INPUT, deps);
    expect(result.decided).toBe(false);
    if (!result.decided) {
      expect(result.reason).toBe("schema_invalid");
    }
  });

  it("never leaks plaintext prompt or model output into logs (test 8)", async () => {
    const deps = makeDeps();
    await runEval(INPUT, deps);
    expect(deps.logs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(deps.logs);
    expect(serialized).not.toContain(SECRET_USER_MSG);
    expect(serialized).not.toContain(SECRET_MODEL_TEXT);
    expect(serialized).not.toContain("classify");
    // Telemetry surface is restricted to safe fields only.
    for (const e of deps.logs) {
      expect(Object.keys(e).sort()).toEqual(["decided", "latency_ms", "model", "reason"]);
    }
  });
});
