import type { ExecutionResult } from "@helm/core";
import { describe, expect, it } from "vitest";
import type { MessagesIdentity } from "./messages.js";
import { createMessagesPipeline, type RouteFn } from "./messages-pipeline.js";

// messages-pipeline (gemini branch) — issue #34 step 3. When the pipeline is
// stamped with the `gemini` protocol, streamIR() must map the upstream OpenAI SSE
// chunks into GEMINI delta events (via geminiTransformer.transformStreamOut),
// NOT Anthropic events. Each event carries an INCREMENTAL text delta (the client
// accumulates `chunk.text` — events do NOT repeat the running text); the terminal
// event carries finishReason + usageMetadata exactly once; there is no `event:` name
// and no `[DONE]` sentinel (those are the route's job — here we only assert the
// produced delta objects). CLAUDE.md principle 8.

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

// Drain streamIR() into an array of plain objects.
async function drain(src: AsyncIterable<Record<string, unknown>>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of src) out.push(ev);
  return out;
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

describe("createMessagesPipeline (gemini) — streamIR yields Gemini delta events", () => {
  it("streams incremental text deltas and ends with finishReason + usageMetadata once", async () => {
    const frames = [
      'data: {"id":"c","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"c","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"c","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    const route: RouteFn = async () => streamResult(openAISSE(frames));
    const pipeline = createMessagesPipeline(route, "gemini");
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);

    const events = (await drain(run.streamIR())) as Array<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { candidatesTokenCount?: number };
    }>;

    expect(events.length).toBeGreaterThan(0);
    // Events are INCREMENTAL deltas: concatenating every event's text yields the full
    // body with no duplication (a cumulative-snapshot impl would yield "HelHello").
    const text = events
      .flatMap((e) => e.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    expect(text).toBe("Hello");
    // finishReason + usageMetadata ride on exactly ONE terminal event (never a STOP
    // frame followed by a stray usage-only frame).
    const withFinish = events.filter((e) => e.candidates?.[0]?.finishReason !== undefined);
    expect(withFinish).toHaveLength(1);
    expect(withFinish[0]?.candidates?.[0]?.finishReason).toBe("STOP");
    const withUsage = events.filter((e) => e.usageMetadata !== undefined);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toBe(withFinish[0]); // same terminal event
    expect(withUsage[0]?.usageMetadata?.candidatesTokenCount).toBe(2);

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

    const events = (await drain(run.streamIR())) as Array<{
      candidates?: Array<{
        content?: { parts?: Array<{ functionCall?: { name: string; args: unknown } }> };
        finishReason?: string;
      }>;
    }>;

    // The functionCall surfaces in EXACTLY ONE event (a delta), with complete args.
    const fcs = events
      .flatMap((e) => e.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.functionCall)
      .filter((fc): fc is { name: string; args: unknown } => fc !== undefined);
    expect(fcs).toHaveLength(1);
    expect(fcs[0]?.name).toBe("get_weather");
    expect(fcs[0]?.args).toEqual({ city: "SF" });
  });
});
