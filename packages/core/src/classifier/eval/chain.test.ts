import { EvalConfigSchema } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvalCache, runEvalCached } from "./cache.js";
import type { ClassifierInput } from "./cache-key.js";
import { type EvalClientDeps, runEval } from "./client.js";

const input: ClassifierInput = {
  messages: [{ role: "user", content: "写一个排序函数" }],
  tools: null,
  response_format: null,
  attachments: null,
};
const output = { complexity: "simple", task_type: "coding", confidence: 0.9 };
const response = { text: JSON.stringify(output), cost_usd: 0.01 };
const chain = [
  { type: "jev", model: "typesafe/jev-1.13", timeout_ms: 100, min_confidence: 0.6 },
  { type: "chat", model: "economy", timeout_ms: 200, min_confidence: 0 },
];
function deps() {
  return {
    config: EvalConfigSchema.parse({
      model: "economy",
      timeout_ms: 100,
      outer_timeout_ms: 350,
      chain,
    }),
    invokeModel: vi.fn(async () => response),
    invokeDecisions: vi.fn<NonNullable<EvalClientDeps<ClassifierInput>["invokeDecisions"]>>(
      async () => response,
    ),
    buildPrompt: () => [{ role: "user", content: "private input" }],
    now: Date.now,
    log: vi.fn(),
  };
}
afterEach(() => vi.useRealTimers());
describe("eval candidate chain", () => {
  it("Jev succeeds without calling economy", async () => {
    const d = deps();
    const result = await runEval(input, d);
    expect(result).toMatchObject({ decided: true, model: chain[0]?.model, output, cost_usd: 0.01 });
    expect(d.invokeDecisions).toHaveBeenCalledOnce();
    expect(d.invokeModel).not.toHaveBeenCalled();
  });
  it.each([
    "error",
    "schema",
    "confidence",
  ])("falls back on %s and keeps billed cost", async (failure) => {
    const d = deps();
    if (failure === "error")
      d.invokeDecisions.mockRejectedValueOnce(new Error("secret upstream error"));
    else
      d.invokeDecisions.mockResolvedValueOnce({
        text: failure === "schema" ? "{}" : JSON.stringify({ ...output, confidence: 0.1 }),
        cost_usd: 0.02,
      });
    const result = await runEval(input, d);
    expect(result).toMatchObject({
      decided: true,
      model: "economy",
      output,
      cost_usd: failure === "error" ? null : 0.03,
    });
    expect(d.invokeModel).toHaveBeenCalledOnce();
    expect(JSON.stringify(d.log.mock.calls)).not.toContain("secret");
  });
  it("aborts a timed-out Jev and leaves time for economy", async () => {
    vi.useFakeTimers();
    const d = deps();
    let signal: AbortSignal | undefined;
    d.invokeDecisions.mockImplementation(
      async (_input: typeof input, _model: string, s: AbortSignal) => {
        signal = s;
        return new Promise<never>(() => {});
      },
    );
    const pending = runEval(input, d);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ decided: true, model: "economy", latency_ms: 100 });
    expect(signal?.aborted).toBe(true);
    expect(d.invokeModel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors order and fails open when every candidate fails", async () => {
    const d = deps();
    d.config.chain?.reverse();
    d.invokeModel.mockRejectedValue(new Error("offline"));
    d.invokeDecisions.mockRejectedValue(new Error("offline"));
    expect(await runEval(input, d)).toMatchObject({ decided: false, reason: "provider_error" });
    expect(d.invokeModel.mock.invocationCallOrder[0]).toBeLessThan(
      d.invokeDecisions.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("caps total time and cancels the active request", async () => {
    vi.useFakeTimers();
    const d = deps();
    d.config.outer_timeout_ms = 150;
    d.invokeDecisions.mockImplementation(() => new Promise<never>(() => {}));
    d.invokeModel.mockImplementation(() => new Promise<never>(() => {}));
    const pending = runEval(input, d);
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toMatchObject({ decided: false, reason: "timeout", latency_ms: 150 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("caches the successful fallback with its actual model, not its billed cost", async () => {
    const d = deps();
    d.invokeDecisions.mockRejectedValue(new Error("offline"));
    const c = { ...d, cache: createEvalCache({ ttlSec: 300, maxEntries: 5 }), nowMs: Date.now() };
    await runEvalCached(input, c);
    expect(await runEvalCached(input, c)).toMatchObject({
      decided: true,
      model: "economy",
      cache_hit: true,
      cost_usd: null,
    });
    expect(d.invokeModel).toHaveBeenCalledOnce();
    expect(d.invokeDecisions).toHaveBeenCalledOnce();
  });
});
