import { describe, expect, it } from "vitest";
import { anthropicTransformer, convertOpenAIStreamToAnthropic } from "./anthropic/index.js";
import { geminiTransformer } from "./gemini/gemini-transformer.js";
import type { IRChunk as GeminiIRChunk, GeminiSSEEvent } from "./gemini/gemini-types.js";
import type { IRResponse } from "./ir.js";
import { openaiTransformer } from "./openai.js";
import { liftReasoningToFlat, resolveReasoning, stripThinkingFromContent } from "./reasoning.js";
import { responsesTransformer } from "./responses.js";

async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of src) out.push(item);
  return out;
}
async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ——————————————————————————————————————————————————————————————————————————————
// Unit: the bridge helpers in isolation.
describe("reasoning bridge — helpers", () => {
  it("liftReasoningToFlat hoists thinking content parts onto reasoning_content + thinking_blocks", () => {
    const lifted = liftReasoningToFlat({
      role: "assistant",
      content: [
        { type: "thinking", text: "step one", signature: "sig" },
        { type: "text", text: "answer" },
      ],
    });
    expect(lifted.reasoning_content).toBe("step one");
    expect(lifted.thinking_blocks).toEqual([
      { type: "thinking", thinking: "step one", signature: "sig" },
    ]);
  });

  it("liftReasoningToFlat does not overwrite pre-existing flat fields", () => {
    const lifted = liftReasoningToFlat({
      role: "assistant",
      content: [{ type: "thinking", text: "ignored" }],
      reasoning_content: "kept",
    });
    expect(lifted.reasoning_content).toBe("kept");
  });

  it("resolveReasoning recovers parts from a flat reasoning_content string", () => {
    const r = resolveReasoning({ role: "assistant", content: "answer", reasoning_content: "why" });
    expect(r.reasoningText).toBe("why");
    expect(r.thinkingParts).toEqual([{ type: "thinking", text: "why" }]);
  });

  it("resolveReasoning recovers parts from thinking_blocks with signature", () => {
    const r = resolveReasoning({
      role: "assistant",
      content: null,
      thinking_blocks: [{ type: "thinking", thinking: "deep", signature: "s" }],
    });
    expect(r.reasoningText).toBe("deep");
    expect(r.thinkingParts).toEqual([{ type: "thinking", text: "deep", signature: "s" }]);
  });

  it("stripThinkingFromContent removes thinking parts but keeps the rest", () => {
    expect(
      stripThinkingFromContent([
        { type: "thinking", text: "x" },
        { type: "text", text: "y" },
      ]),
    ).toEqual([{ type: "text", text: "y" }]);
    expect(stripThinkingFromContent([{ type: "thinking", text: "x" }])).toBe("");
    expect(stripThinkingFromContent("plain")).toBe("plain");
  });
});

// ——————————————————————————————————————————————————————————————————————————————
// Non-streaming cross-protocol round-trips THROUGH the IR.
const anthropicThinkingResponse = {
  id: "msg_1",
  type: "message" as const,
  role: "assistant" as const,
  model: "claude",
  content: [
    { type: "thinking", thinking: "Let me reason carefully.", signature: "sig123" },
    { type: "text", text: "The answer is 42." },
  ],
  stop_reason: "end_turn" as const,
  stop_sequence: null,
  usage: {
    input_tokens: 5,
    output_tokens: 3,
    cache_read_input_tokens: 0,
    output_tokens_details: { thinking_tokens: 7 },
  },
};

describe("reasoning round-trip — anthropic thinking -> IR -> openai", () => {
  it("surfaces Anthropic thinking as IR reasoning_content/thinking_blocks", async () => {
    const ir = await anthropicTransformer.transformResponseIn(anthropicThinkingResponse);
    const msg = ir.choices[0]?.message;
    expect(msg?.reasoning_content).toBe("Let me reason carefully.");
    expect(msg?.thinking_blocks?.[0]).toMatchObject({
      type: "thinking",
      thinking: "Let me reason carefully.",
      signature: "sig123",
    });
  });

  it("emits message.reasoning_content (not a content-block) on the OpenAI wire", async () => {
    const ir = await anthropicTransformer.transformResponseIn(anthropicThinkingResponse);
    const oai = (await openaiTransformer.transformResponseOut(ir)) as {
      choices: Array<{ message: { content: unknown; reasoning_content?: string } }>;
    };
    const msg = oai.choices[0]?.message;
    expect(msg?.reasoning_content).toBe("Let me reason carefully.");
    // OpenAI clients expect a plain string content; a {type:"thinking"} part must
    // NOT leak into the content array.
    expect(JSON.stringify(msg?.content)).not.toContain("thinking");
    expect(JSON.stringify(msg?.content)).toContain("The answer is 42.");
  });
});

describe("reasoning round-trip — anthropic thinking -> IR -> gemini", () => {
  it("emits a Gemini thought part (reasoning is NOT dropped)", async () => {
    const ir = await anthropicTransformer.transformResponseIn(anthropicThinkingResponse);
    const gem = (await geminiTransformer.transformResponseOut(ir)) as {
      candidates: Array<{ content: { parts: Array<{ text?: string; thought?: boolean }> } }>;
    };
    const parts = gem.candidates[0]?.content.parts ?? [];
    const thoughtPart = parts.find((p) => p.thought === true);
    expect(thoughtPart?.text).toBe("Let me reason carefully.");
    // Visible answer still present as a non-thought part.
    expect(parts.some((p) => p.thought !== true && p.text === "The answer is 42.")).toBe(true);
  });
});

describe("reasoning round-trip — openai reasoning_content -> IR -> anthropic thinking", () => {
  it("renders an Anthropic thinking block from a flat reasoning_content", async () => {
    const ir = await openaiTransformer.transformResponseIn({
      id: "chatcmpl-r",
      model: "o1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ans", reasoning_content: "deduction" },
          finish_reason: "stop",
        },
      ],
    });
    const anth = (await anthropicTransformer.transformResponseOut(ir)) as {
      content: Array<{ type: string; thinking?: string; text?: string }>;
    };
    const thinking = anth.content.find((b) => b.type === "thinking");
    expect(thinking?.thinking).toBe("deduction");
    expect(anth.content.some((b) => b.type === "text" && b.text === "ans")).toBe(true);
  });
});

describe("reasoning round-trip — gemini thought -> IR -> anthropic thinking", () => {
  it("normalizes a Gemini thought part into IR reasoning + renders Anthropic thinking", async () => {
    const geminiNative = {
      modelVersion: "gemini",
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "internal chain", thought: true }, { text: "Final answer." }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 4 },
    };
    const ir = await geminiTransformer.transformResponseIn(geminiNative);
    const msg = ir.choices[0]?.message;
    // Gemini thought becomes a typed thinking content part + flat reasoning_content,
    // and must NOT leak into a visible TEXT part.
    expect(msg?.reasoning_content).toBe("internal chain");
    const parts = Array.isArray(msg?.content) ? msg?.content : [];
    expect(parts.find((p) => p.type === "thinking")).toMatchObject({ text: "internal chain" });
    const textParts = parts.filter((p) => p.type === "text");
    expect(textParts.some((p) => p.type === "text" && p.text === "Final answer.")).toBe(true);
    expect(JSON.stringify(textParts)).not.toContain("internal chain");

    const anth = (await anthropicTransformer.transformResponseOut(ir)) as {
      content: Array<{ type: string; thinking?: string; text?: string }>;
    };
    expect(anth.content.find((b) => b.type === "thinking")?.thinking).toBe("internal chain");
  });
});

describe("reasoning round-trip — anthropic thinking -> IR -> responses", () => {
  it("renders a Responses reasoning item from Anthropic thinking", async () => {
    const ir = await anthropicTransformer.transformResponseIn(anthropicThinkingResponse);
    const resp = (await responsesTransformer.transformResponseOut(ir)) as {
      output: Array<{ type: string; summary?: Array<{ text: string }> }>;
    };
    const reasoning = resp.output.find((o) => o.type === "reasoning");
    expect(reasoning?.summary?.[0]?.text).toBe("Let me reason carefully.");
  });
});

// ——————————————————————————————————————————————————————————————————————————————
// Streaming: reasoning deltas survive openai <-> anthropic <-> gemini conversion.
describe("reasoning streaming — IR reasoning_content delta survives to all targets", () => {
  const chunks: GeminiIRChunk[] = [
    {
      id: "c1",
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking…" } }],
    },
    {
      id: "c1",
      model: "m",
      choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }],
    },
  ];

  it("anthropic stream out emits thinking_delta from reasoning_content", async () => {
    const events = await collect(convertOpenAIStreamToAnthropic(fromArray(chunks)));
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("thinking_delta");
    expect(serialized).toContain("thinking…");
  });

  it("gemini stream out emits a thought part from reasoning_content", async () => {
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(chunks)));
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('"thought":true');
    expect(serialized).toContain("thinking…");
  });
});

describe("reasoning streaming — anthropic thinking_delta -> IR -> gemini thought", () => {
  it("round-trips a native Anthropic thinking_delta stream into a Gemini thought part", async () => {
    const anthropicStream = [
      {
        type: "message_start" as const,
        message: {
          id: "msg",
          type: "message" as const,
          role: "assistant" as const,
          model: "m",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "content_block_start" as const,
        index: 0,
        content_block: { type: "thinking" as const, thinking: "" },
      },
      {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "thinking_delta" as const, thinking: "reasoned" },
      },
      { type: "content_block_stop" as const, index: 0 },
      {
        type: "message_delta" as const,
        delta: { stop_reason: "end_turn" as const, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" as const },
    ];
    const irChunks = await collect(
      anthropicTransformer.transformStreamIn(fromArray(anthropicStream)),
    );
    expect(JSON.stringify(irChunks)).toContain("reasoned");
    const geminiEvents = await collect(geminiTransformer.transformStreamOut(fromArray(irChunks)));
    const serialized = JSON.stringify(geminiEvents);
    expect(serialized).toContain('"thought":true');
    expect(serialized).toContain("reasoned");
  });
});

describe("reasoning streaming — gemini thought -> IR -> anthropic thinking_delta", () => {
  it("round-trips a Gemini thought snapshot stream into an Anthropic thinking_delta", async () => {
    const snapshots: GeminiSSEEvent[] = [
      {
        modelVersion: "m",
        candidates: [{ content: { role: "model", parts: [{ text: "ponder", thought: true }] } }],
      },
      {
        modelVersion: "m",
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "ponder", thought: true }, { text: "done" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 2 },
      },
    ];
    const irChunks = await collect(geminiTransformer.transformStreamIn(fromArray(snapshots)));
    expect(JSON.stringify(irChunks)).toContain("ponder");
    const anthropicEvents = await collect(convertOpenAIStreamToAnthropic(fromArray(irChunks)));
    const serialized = JSON.stringify(anthropicEvents);
    expect(serialized).toContain("thinking_delta");
    expect(serialized).toContain("ponder");
  });
});

// Guard the shared IRResponse type is the one consumed (compile-time anchor).
const _typeAnchor: IRResponse | undefined = undefined;
void _typeAnchor;
