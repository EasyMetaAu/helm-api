import type { InternalRequest, NativePassthroughCarrier } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { clampClientReasoningEffortToKeyMax } from "./reasoning-cap.js";

function request(overrides: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req_1",
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
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
    ...overrides,
  };
}

function carrier(
  protocol: NativePassthroughCarrier["protocol"],
  body: Record<string, unknown>,
): NativePassthroughCarrier {
  return { protocol, body, headers: {}, mutations: {} };
}

describe("clampClientReasoningEffortToKeyMax", () => {
  it("returns the request untouched when there is no cap", () => {
    const req = request({ reasoning_effort: "xhigh" });
    expect(clampClientReasoningEffortToKeyMax(req, null)).toBe(req);
    expect(clampClientReasoningEffortToKeyMax(req, undefined)).toBe(req);
  });

  it("leaves an already-below-cap client effort untouched", () => {
    const req = request({ reasoning_effort: "low" });
    expect(clampClientReasoningEffortToKeyMax(req, "medium")).toBe(req);
    expect(clampClientReasoningEffortToKeyMax(req, "medium").reasoning_effort).toBe("low");
  });

  it("clamps the normalized reasoning_effort down to the cap (OpenAI chat / translated)", () => {
    const req = request({ reasoning_effort: "xhigh" });
    const out = clampClientReasoningEffortToKeyMax(req, "medium");
    expect(out).not.toBe(req);
    expect(out.reasoning_effort).toBe("medium");
    expect(req.reasoning_effort).toBe("xhigh"); // input not mutated
  });

  it("clamps OpenAI Responses reasoning.effort in the native carrier", () => {
    const native = carrier("openai_responses", {
      model: "gpt-5.5",
      reasoning: { effort: "xhigh" },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "medium");
    const outNative = out.native_request as NativePassthroughCarrier;
    expect((outNative.body.reasoning as { effort: string }).effort).toBe("medium");
    expect(outNative.mutations.body_shims_applied).toContain("client_reasoning_effort_capped");
    // Input carrier not mutated in place.
    expect((native.body.reasoning as { effort: string }).effort).toBe("xhigh");
  });

  it("does not touch a Responses body already at or below the cap", () => {
    const native = carrier("openai_responses", { model: "gpt-5.5", reasoning: { effort: "low" } });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "medium");
    expect(out.native_request).toBe(native);
  });

  it("clamps the Anthropic thinking budget down to the cap tier's budget", () => {
    // xhigh budget (24576) exceeds medium's ceiling (8192) => clamp.
    const native = carrier("anthropic_messages", {
      model: "claude-opus-4-8",
      thinking: { type: "enabled", budget_tokens: 24576 },
      max_tokens: 1000,
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "medium");
    const outNative = out.native_request as NativePassthroughCarrier;
    expect(outNative.body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    // applyForcedReasoningToNativeBody repairs max_tokens > budget and forces temp=1.
    expect(outNative.body.max_tokens).toBe(8192 + 8192);
    expect(outNative.body.temperature).toBe(1);
    expect(outNative.mutations.body_shims_applied).toContain("client_reasoning_effort_capped");
  });

  it("leaves an Anthropic thinking budget already within the cap untouched", () => {
    // low budget (2048) is below medium's ceiling (8192) => no clamp.
    const native = carrier("anthropic_messages", {
      model: "claude-opus-4-8",
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "medium");
    expect(out.native_request).toBe(native);
  });

  it("strips Anthropic thinking entirely when the cap is none", () => {
    const native = carrier("anthropic_messages", {
      model: "claude-opus-4-8",
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "none");
    const outNative = out.native_request as NativePassthroughCarrier;
    expect(outNative.body.thinking).toBeUndefined();
    expect(outNative.mutations.body_shims_applied).toContain("client_reasoning_effort_capped");
  });

  it("clamps the Gemini thinkingBudget down to the cap tier", () => {
    // high budget (24576) exceeds medium's ceiling (8192) => clamp.
    const native = carrier("gemini", {
      generationConfig: {
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 24576, includeThoughts: true },
      },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "medium");
    const outNative = out.native_request as NativePassthroughCarrier;
    const gen = outNative.body.generationConfig as {
      temperature: number;
      thinkingConfig: { thinkingBudget: number };
    };
    expect(gen.thinkingConfig.thinkingBudget).toBe(8192); // medium
    expect(gen.temperature).toBe(0.7); // rest of generationConfig preserved
    expect(outNative.mutations.body_shims_applied).toContain("client_reasoning_effort_capped");
  });

  it("does not clamp when the native body carries no reasoning field", () => {
    const native = carrier("anthropic_messages", { model: "claude-opus-4-8" });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "medium");
    expect(out.native_request).toBe(native);
  });

  // —— IR-level Anthropic `thinking` (translated path — thinkingFromIR "explicit wins") ——
  it("clamps an over-cap IR thinking.budget_tokens down to the cap tier (translated Anthropic)", () => {
    const req = request({
      protocol: "anthropic_messages",
      thinking: { type: "enabled", budget_tokens: 30000 },
    });
    const out = clampClientReasoningEffortToKeyMax(req, "medium");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8192 }); // medium
    // Input not mutated.
    expect((req.thinking as { budget_tokens: number }).budget_tokens).toBe(30000);
  });

  it("leaves an IR thinking budget already within the cap untouched", () => {
    const req = request({
      protocol: "anthropic_messages",
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    expect(clampClientReasoningEffortToKeyMax(req, "medium").thinking).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
  });

  it("strips an IR thinking config entirely when the cap is none", () => {
    const req = request({
      protocol: "anthropic_messages",
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    expect(clampClientReasoningEffortToKeyMax(req, "none").thinking).toBeUndefined();
  });

  // —— Gemini dynamic budget (-1) and thinkingLevel (cost-control bypasses) ——
  it("clamps a Gemini dynamic thinkingBudget (-1 = unbounded) down to the cap tier", () => {
    const native = carrier("gemini", {
      generationConfig: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "low");
    const gen = (out.native_request as NativePassthroughCarrier).body.generationConfig as {
      thinkingConfig: { thinkingBudget: number };
    };
    expect(gen.thinkingConfig.thinkingBudget).toBe(1024); // low
  });

  it("clamps a Gemini thinkingLevel string down to the cap tier's budget", () => {
    const native = carrier("gemini", {
      generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "minimal");
    const outNative = out.native_request as NativePassthroughCarrier;
    const gen = outNative.body.generationConfig as {
      thinkingConfig: { thinkingBudget?: number; thinkingLevel?: string };
    };
    // Rewritten to the cap tier's budget; the client thinkingLevel is dropped.
    expect(gen.thinkingConfig.thinkingBudget).toBe(128); // minimal
    expect(gen.thinkingConfig.thinkingLevel).toBeUndefined();
    expect(outNative.mutations.body_shims_applied).toContain("client_reasoning_effort_capped");
  });

  it("leaves a Gemini thinkingLevel already BELOW the cap untouched (ceiling, not floor)", () => {
    const native = carrier("gemini", {
      generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
    });
    // Cap high; client asked LOW → keep the cheaper client choice, do not raise it.
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "high");
    expect(out.native_request).toBe(native);
  });

  it("clamps an UNKNOWN Gemini thinkingLevel (fail-closed) down to the cap tier", () => {
    const native = carrier("gemini", {
      generationConfig: { thinkingConfig: { thinkingLevel: "EXTREME" } },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "low");
    const gen = (out.native_request as NativePassthroughCarrier).body.generationConfig as {
      thinkingConfig: { thinkingBudget: number };
    };
    expect(gen.thinkingConfig.thinkingBudget).toBe(1024); // low
  });

  it("repairs max_tokens + sampling when clamping an IR thinking budget (Anthropic 400 guard)", () => {
    // Client max_tokens (1000) is below the capped medium budget (8192) → must be raised;
    // extended thinking also requires temperature=1 and no top_p/top_k.
    const req = request({
      protocol: "anthropic_messages",
      max_tokens: 1000,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      thinking: { type: "enabled", budget_tokens: 30000 },
    });
    const out = clampClientReasoningEffortToKeyMax(req, "medium");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(out.max_tokens).toBe(8192 + 8192); // budget + output headroom
    expect(out.temperature).toBe(1);
    expect(out.top_p).toBeUndefined();
    expect(out.top_k).toBeUndefined();
  });

  it("raises max_completion_tokens (not just max_tokens) when the client used it", () => {
    // The Anthropic provider path prefers max_completion_tokens; a stale one below the
    // capped budget would 400. max_tokens is unset → must NOT be introduced.
    const req = request({
      protocol: "anthropic_messages",
      max_completion_tokens: 1000,
      thinking: { type: "enabled", budget_tokens: 30000 },
    });
    const out = clampClientReasoningEffortToKeyMax(req, "medium");
    expect(out.max_completion_tokens).toBe(8192 + 8192);
    expect(out.max_tokens).toBeNull(); // untouched (client never set it)
  });

  it("does not equalize the two max fields, and leaves an already-sufficient one alone", () => {
    // max_tokens huge (already above floor) stays; max_completion_tokens below floor is
    // raised only to the floor — the two are NOT collapsed to max(both).
    const req = request({
      protocol: "anthropic_messages",
      max_tokens: 100000,
      max_completion_tokens: 1000,
      thinking: { type: "enabled", budget_tokens: 30000 },
    });
    const out = clampClientReasoningEffortToKeyMax(req, "medium");
    expect(out.max_tokens).toBe(100000); // already above floor → untouched
    expect(out.max_completion_tokens).toBe(8192 + 8192); // raised to floor only
  });

  it("does NOT seed a bogus max_tokens when the cap is none (thinking stripped)", () => {
    // Cap none strips thinking → no budget constraint → must NOT seed max_tokens:0.
    const req = request({
      protocol: "anthropic_messages",
      thinking: { type: "enabled", budget_tokens: 30000 },
    });
    const out = clampClientReasoningEffortToKeyMax(req, "none");
    expect(out.thinking).toBeUndefined();
    expect(out.max_tokens).toBeNull(); // untouched — not seeded to 0
    expect(out.temperature).toBeUndefined(); // sampling left alone when thinking stripped
  });

  // —— Unknown/future effort string must NOT slip under the cap ——
  it("clamps an UNKNOWN Responses effort string (treats it as over any cap)", () => {
    const native = carrier("openai_responses", {
      model: "gpt-5.5",
      reasoning: { effort: "ultra" },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "medium");
    const outNative = out.native_request as NativePassthroughCarrier;
    expect((outNative.body.reasoning as { effort: string }).effort).toBe("medium");
  });

  it("clamps an UNKNOWN normalized reasoning_effort string down to the cap", () => {
    const req = request({ reasoning_effort: "ultra" });
    expect(clampClientReasoningEffortToKeyMax(req, "medium").reasoning_effort).toBe("medium");
  });

  // —— Anthropic output_config.effort (outbound path prefers it over reasoning_effort) ——
  it("clamps an over-cap IR provider_raw.output_config.effort down to the cap", () => {
    const req = request({
      protocol: "anthropic_messages",
      provider_raw: { output_config: { effort: "xhigh", other: 1 } },
    });
    const out = clampClientReasoningEffortToKeyMax(req, "medium");
    expect((out.provider_raw?.output_config as { effort: string }).effort).toBe("medium");
    expect((out.provider_raw?.output_config as { other: number }).other).toBe(1); // preserved
  });

  it("strips output_config.effort when the cap is none", () => {
    const req = request({
      protocol: "anthropic_messages",
      provider_raw: { output_config: { effort: "high" } },
    });
    const out = clampClientReasoningEffortToKeyMax(req, "none");
    expect((out.provider_raw?.output_config as { effort?: string }).effort).toBeUndefined();
  });

  it("clamps an over-cap output_config.effort in the native Anthropic carrier", () => {
    const native = carrier("anthropic_messages", {
      model: "claude-opus-4-8",
      output_config: { effort: "xhigh" },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "low");
    const outNative = out.native_request as NativePassthroughCarrier;
    expect((outNative.body.output_config as { effort: string }).effort).toBe("low");
    expect(outNative.mutations.body_shims_applied).toContain("client_reasoning_effort_capped");
  });

  // —— Anthropic enabled thinking with no usable numeric budget (fail-closed) ——
  it("clamps an IR thinking object that is enabled but has no numeric budget", () => {
    const req = request({
      protocol: "anthropic_messages",
      thinking: { type: "adaptive" },
    });
    const out = clampClientReasoningEffortToKeyMax(req, "medium");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8192 }); // medium tier
  });

  it("clamps a native Anthropic thinking object with no numeric budget", () => {
    const native = carrier("anthropic_messages", {
      model: "claude-opus-4-8",
      thinking: { type: "adaptive" },
    });
    const out = clampClientReasoningEffortToKeyMax(request({ native_request: native }), "low");
    const outNative = out.native_request as NativePassthroughCarrier;
    expect(outNative.body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 }); // low
  });

  it("leaves a disabled thinking object untouched even under a cap", () => {
    const req = request({
      protocol: "anthropic_messages",
      thinking: { type: "disabled" },
    });
    expect(clampClientReasoningEffortToKeyMax(req, "low")).toBe(req);
  });
});
