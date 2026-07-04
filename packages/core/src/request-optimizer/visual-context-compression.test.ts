import type { PxpipeTransformInput, PxpipeTransformResult } from "pxpipe-proxy/transform";
import { describe, expect, it, vi } from "vitest";
import { optimizeVisualContext } from "./visual-context-compression.js";

const caps = {
  supportsTools: true,
  jsonOutput: "schema" as const,
  supportsVision: true,
  supportsStreaming: true,
  maxContextTokens: 200_000,
  maxOutputTokens: 16_384,
};

function encoded(body: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

function pxpipeResult(body: Record<string, unknown>, applied = true): PxpipeTransformResult {
  return {
    body: encoded(body),
    applied,
    reason: applied ? "applied" : "not_profitable",
    detail: applied ? undefined : "not_profitable",
    info: {
      compressed: applied,
      origChars: 50_000,
      compressedChars: applied ? 42_000 : 0,
      imageCount: applied ? 2 : 0,
      imageBytes: applied ? 12_345 : 0,
      imagePixels: applied ? 1_500_000 : 0,
      staticChars: applied ? 40_000 : 0,
      dynamicChars: 100,
      dynamicBlockCount: 1,
      droppedChars: 0,
      keptSharpBlocks: 1,
    },
    cache: { ownsCacheControl: applied, markerCount: applied ? 1 : 0 },
  };
}

describe("optimizeVisualContext", () => {
  it("is a no-op with no telemetry when disabled", async () => {
    const transformer = vi.fn();
    const body = { model: "claude-fable-5", messages: [{ role: "user", content: "hello" }] };

    const out = await optimizeVisualContext({
      mode: "off",
      targetProviderProtocol: "anthropic_messages",
      model: "claude-fable-5",
      body,
      capabilities: caps,
      transformer,
    });

    expect(out.body).toBe(body);
    expect(out.mutation).toBeUndefined();
    expect(transformer).not.toHaveBeenCalled();
  });

  it("records would_apply in observe mode without replacing the body", async () => {
    const original = { model: "claude-fable-5", messages: [{ role: "user", content: "hello" }] };
    const transformed = {
      ...original,
      messages: [{ role: "user", content: [{ type: "image", source: { data: "png" } }] }],
    };
    const transformer = vi.fn(async () => pxpipeResult(transformed));

    const out = await optimizeVisualContext({
      mode: "observe",
      targetProviderProtocol: "anthropic_messages",
      model: "claude-fable-5",
      body: original,
      capabilities: caps,
      transformer,
    });

    expect(out.body).toBe(original);
    expect(out.mutation).toMatchObject({
      mode: "observe",
      applied: false,
      would_apply: true,
      reason: "applied",
      compressed_chars: 42_000,
      image_count: 2,
      owns_cache_control: true,
      marker_count: 1,
    });
  });

  it("replaces the body only when enabled and pxpipe applied", async () => {
    const original = { model: "claude-fable-5", messages: [{ role: "user", content: "hello" }] };
    const transformed = {
      ...original,
      messages: [{ role: "user", content: [{ type: "image", source: { data: "png" } }] }],
    };

    const out = await optimizeVisualContext({
      mode: "enabled",
      targetProviderProtocol: "anthropic_messages",
      model: "claude-fable-5",
      body: original,
      capabilities: caps,
      transformer: async () => pxpipeResult(transformed),
    });

    expect(out.body).toEqual(transformed);
    expect(out.mutation).toMatchObject({
      mode: "enabled",
      applied: true,
      would_apply: true,
      reason: "applied",
      estimated_image_tokens: 2200,
    });
  });

  it("skips non-vision targets before calling pxpipe", async () => {
    const transformer = vi.fn();
    const out = await optimizeVisualContext({
      mode: "enabled",
      targetProviderProtocol: "anthropic_messages",
      model: "deepseek-v4-pro",
      body: { model: "deepseek-v4-pro", messages: [] },
      capabilities: { ...caps, supportsVision: false },
      transformer,
    });

    expect(transformer).not.toHaveBeenCalled();
    expect(out.mutation).toMatchObject({
      applied: false,
      would_apply: false,
      reason: "no_vision_support",
    });
  });

  it("pins exact strings as text through keepSharp", async () => {
    let captured: PxpipeTransformInput["options"];
    const transformer = vi.fn(async (input: PxpipeTransformInput) => {
      captured = input.options;
      return pxpipeResult(input.body as never, false);
    });

    await optimizeVisualContext({
      mode: "observe",
      targetProviderProtocol: "anthropic_messages",
      model: "claude-fable-5",
      body: { model: "claude-fable-5", messages: [] },
      capabilities: caps,
      transformer,
    });

    expect(captured?.keepSharp?.({ kind: "tool_result", text: "trace_id=req_123456" })).toBe(true);
    expect(captured?.keepSharp?.({ kind: "tool_result", text: "plain prose without ids" })).toBe(
      false,
    );
  });
});
