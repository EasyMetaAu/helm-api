import type { ExecutionResult } from "@helm/core";
import { describe, expect, it } from "vitest";
import type { MessagesIdentity } from "./messages.js";
import { createMessagesPipeline, type RouteFn } from "./messages-pipeline.js";

// messages-pipeline (gemini branch) — issue #34 step 3. When the pipeline is
// stamped with the `gemini` protocol, streamIR() must map the upstream OpenAI SSE
// chunks into GEMINI snapshot events (via geminiTransformer.transformStreamOut),
// NOT Anthropic events. Each snapshot is a FULL response (text accumulates frame to
// frame); the terminal snapshot carries finishReason + usageMetadata exactly once;
// there is no `event:` name and no `[DONE]` sentinel (those are the route's job —
// here we only assert the produced snapshot objects). CLAUDE.md principle 8.

const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };

function irOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gemini-2.0-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    metadata: { trace_id: "trace-g" },
    ...over,
  };
}

// Raw OpenAI SSE text the mock upstream / executor yields. Text fragments then a
// terminal usage+finish frame and the [DONE] sentinel — the same wire the
// Anthropic pipeline consumes.
async function* openAISSE(frames: string[]): AsyncIterable<string> {
  for (const f of frames) yield f;
}

function streamResult(stream: AsyncIterable<string>): ExecutionResult {
  return {
    decision: { lane: { selected_lane: "balanced" } } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "x" } as unknown as ExecutionResult["final"],
    body: null,
    stream,
    error: null,
  };
}

describe("createMessagesPipeline (gemini) — streamIR yields Gemini snapshots", () => {
  it("accumulates text across snapshots and ends with finishReason + usageMetadata", async () => {
    const frames = [
      'data: {"id":"c","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"c","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"c","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    const route: RouteFn = async () => streamResult(openAISSE(frames));
    const pipeline = createMessagesPipeline(route, "gemini");
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of run.streamIR()) events.push(ev as Record<string, unknown>);

    expect(events.length).toBeGreaterThan(0);
    // Each event is a full snapshot; the LAST carries the complete accumulated text.
    const last = events[events.length - 1] as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { candidatesTokenCount?: number };
    };
    const text = (last.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    expect(text).toBe("Hello");
    expect(last.candidates?.[0]?.finishReason).toBe("STOP");
    expect(last.usageMetadata?.candidatesTokenCount).toBe(2);

    // No Anthropic event names leaked through the Gemini surface.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("message_start");
    expect(serialized).not.toContain("content_block_delta");
  });

  it("emits a functionCall part accumulated across fragmented tool-call chunks", async () => {
    const frames = [
      'data: {"id":"c","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"get_weather"}}]}}]}\n\n',
      'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]}}]}\n\n',
      'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"SF\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const route: RouteFn = async () => streamResult(openAISSE(frames));
    const pipeline = createMessagesPipeline(route, "gemini");
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of run.streamIR()) events.push(ev as Record<string, unknown>);

    const last = events[events.length - 1] as {
      candidates?: Array<{
        content?: { parts?: Array<{ functionCall?: { name: string; args: unknown } }> };
        finishReason?: string;
      }>;
    };
    const fc = (last.candidates?.[0]?.content?.parts ?? []).find(
      (p) => p.functionCall,
    )?.functionCall;
    expect(fc?.name).toBe("get_weather");
    expect(fc?.args).toEqual({ city: "SF" });
  });
});
