import type { CatalogEntry } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { type CapabilityRequest, checkCapability } from "./filter.js";

type Caps = CatalogEntry["capabilities"];

// A fully-capable candidate with a generous context window. Tests override
// only the fields relevant to the gate under test.
function caps(overrides: Partial<Caps> = {}): Caps {
  return {
    supportsTools: true,
    supportsJsonMode: true,
    supportsVision: true,
    supportsStreaming: true,
    maxContextTokens: 100_000,
    maxOutputTokens: null,
    ...overrides,
  };
}

// A request that demands nothing and fits any window. Tests turn individual
// needs on.
function req(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    needsTools: false,
    needsJson: false,
    needsVision: false,
    needsStreaming: false,
    estimatedPromptTokens: 0,
    maxTokens: null,
    ...overrides,
  };
}

describe("checkCapability", () => {
  it("skips with no_tool_support when tools are required but unsupported", () => {
    const result = checkCapability(caps({ supportsTools: false }), req({ needsTools: true }));
    expect(result).toEqual({ ok: false, skipReason: "no_tool_support" });
  });

  it("passes the tool gate when the candidate supports tools", () => {
    const result = checkCapability(caps({ supportsTools: true }), req({ needsTools: true }));
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("skips with no_json_support when strict JSON is required but unsupported", () => {
    const result = checkCapability(caps({ supportsJsonMode: false }), req({ needsJson: true }));
    expect(result).toEqual({ ok: false, skipReason: "no_json_support" });
  });

  it("passes the json gate when the candidate supports JSON mode", () => {
    const result = checkCapability(caps({ supportsJsonMode: true }), req({ needsJson: true }));
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("skips with no_vision_support when vision is required but unsupported", () => {
    const result = checkCapability(caps({ supportsVision: false }), req({ needsVision: true }));
    expect(result).toEqual({ ok: false, skipReason: "no_vision_support" });
  });

  it("returns no_vision_support for json+vision when json passes but vision fails", () => {
    const result = checkCapability(
      caps({ supportsJsonMode: true, supportsVision: false }),
      req({ needsJson: true, needsVision: true }),
    );
    expect(result).toEqual({ ok: false, skipReason: "no_vision_support" });
  });

  it("passes when both json and vision are supported and required", () => {
    const result = checkCapability(
      caps({ supportsJsonMode: true, supportsVision: true }),
      req({ needsJson: true, needsVision: true }),
    );
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("skips with context_too_small when prompt+maxTokens exceeds the window", () => {
    const result = checkCapability(
      caps({ maxContextTokens: 1000 }),
      req({ estimatedPromptTokens: 800, maxTokens: 300 }),
    );
    expect(result).toEqual({ ok: false, skipReason: "context_too_small" });
  });

  it("passes the context gate when prompt+maxTokens equals the window exactly", () => {
    const result = checkCapability(
      caps({ maxContextTokens: 1000 }),
      req({ estimatedPromptTokens: 700, maxTokens: 300 }),
    );
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("treats null maxTokens as zero output budget for the context gate", () => {
    const result = checkCapability(
      caps({ maxContextTokens: 1000 }),
      req({ estimatedPromptTokens: 1000, maxTokens: null }),
    );
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("skips with no_streaming_support when streaming is required but unsupported", () => {
    const result = checkCapability(
      caps({ supportsStreaming: false }),
      req({ needsStreaming: true }),
    );
    expect(result).toEqual({ ok: false, skipReason: "no_streaming_support" });
  });

  it("skips with no_nonstream_support when a stream-only candidate gets a non-stream request", () => {
    const result = checkCapability(
      caps({ requiresStreaming: true }),
      req({ needsStreaming: false }),
    );
    expect(result).toEqual({ ok: false, skipReason: "no_nonstream_support" });
  });

  it("lets a stream-only candidate serve a streaming request (requiresStreaming met)", () => {
    const result = checkCapability(
      caps({ requiresStreaming: true }),
      req({ needsStreaming: true }),
    );
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("does not gate non-stream requests against models that are not stream-only", () => {
    const result = checkCapability(
      caps({ requiresStreaming: false }),
      req({ needsStreaming: false }),
    );
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("treats an absent requiresStreaming as not stream-only (back-compat)", () => {
    // caps() never sets requiresStreaming (mirrors a generated-catalog entry); a
    // non-stream request must pass, not be wrongly skipped.
    const result = checkCapability(caps(), req());
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("passes when every required capability is satisfied", () => {
    const result = checkCapability(
      caps(),
      req({
        needsTools: true,
        needsJson: true,
        needsVision: true,
        needsStreaming: true,
        estimatedPromptTokens: 5000,
        maxTokens: 2000,
      }),
    );
    expect(result).toEqual({ ok: true, skipReason: null });
  });

  it("short-circuits on the first failing gate (tools before json)", () => {
    const result = checkCapability(
      caps({ supportsTools: false, supportsJsonMode: false }),
      req({ needsTools: true, needsJson: true }),
    );
    expect(result).toEqual({ ok: false, skipReason: "no_tool_support" });
  });
});
