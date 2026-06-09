import { type ErrorClass, makeHelmError } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  type AnthropicSSEEvent,
  anthropicTransformer,
  convertOpenAIStreamToAnthropic,
  transformErrorOut as transformAnthropicErrorOut,
} from "./anthropic/index.js";
import { transformErrorOut as transformGeminiErrorOut } from "./gemini/error.js";
import { geminiTransformer } from "./gemini/gemini-transformer.js";
import type { IRChunk as GeminiIRChunk, GeminiSSEEvent } from "./gemini/gemini-types.js";
import type { IRRequest, IRResponse } from "./ir.js";
import { IRRequestSchema, IRResponseSchema } from "./ir.js";
import { openaiTransformer } from "./openai.js";
import { transformErrorOut as transformOpenAIErrorOut } from "./openai-error.js";
import {
  canonicalAnnotationResponseIR,
  canonicalReasoningResponseIR,
  canonicalRequestIR,
  canonicalResponseIR,
  type ProtocolMatrixDimension,
  type ProtocolMatrixPath,
  type ProtocolName,
  protocolCrossPathMatrix,
  protocolIdentityMatrix,
  protocolMatrix,
  protocolMatrixDimensions,
  protocolMatrixProvenance,
  protocols,
} from "./protocol-matrix.fixtures.js";
import { responsesTransformer } from "./responses.js";
import type { Transformer } from "./transformer.js";

async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of src) out.push(item);
  return out;
}

async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

const requestOut: Record<ProtocolName, (native: unknown) => IRRequest | Promise<IRRequest>> = {
  openai: (native) => openaiTransformer.transformRequestOut(native),
  anthropic: (native) => anthropicTransformer.transformRequestOut(native),
  gemini: (native) => geminiTransformer.transformRequestOut(native),
  responses: (native) => responsesTransformer.transformRequestOut(native),
};

const responseOut: Record<ProtocolName, (ir: IRResponse) => unknown | Promise<unknown>> = {
  openai: (ir) => openaiTransformer.transformResponseOut(ir),
  anthropic: (ir) => anthropicTransformer.transformResponseOut(ir),
  gemini: (ir) => geminiTransformer.transformResponseOut(ir),
  responses: (ir) => responsesTransformer.transformResponseOut(ir),
};

const requestIn: Partial<Record<ProtocolName, Transformer["transformRequestIn"]>> = {
  openai: (ir) => openaiTransformer.transformRequestIn(ir),
  anthropic: (ir) => anthropicTransformer.transformRequestIn(ir),
  gemini: (ir) => geminiTransformer.transformRequestIn(ir),
  responses: (ir) => responsesTransformer.transformRequestIn(ir),
};

// Provider-native response -> IR, per source protocol. All four protocols are
// bidirectional now (issue #59 Theme 2 for anthropic; Responses since P5).
const responseInBySource: Partial<
  Record<ProtocolName, (native: unknown) => IRResponse | Promise<IRResponse>>
> = {
  openai: (native) => openaiTransformer.transformResponseIn(native),
  anthropic: (native) => anthropicTransformer.transformResponseIn(native),
  gemini: (native) => geminiTransformer.transformResponseIn(native),
  responses: (native) => responsesTransformer.transformResponseIn(native),
};

function nativeRequest(protocol: ProtocolName): unknown {
  if (protocol === "openai") {
    return {
      model: "matrix-model",
      messages: canonicalRequestIR.messages,
      tools: canonicalRequestIR.tools,
      tool_choice: "auto",
      response_format: canonicalRequestIR.response_format,
      stream: true,
    };
  }

  if (protocol === "anthropic") {
    return {
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      system: "Be precise.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image and call the tool." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Calling weather." },
            {
              type: "tool_use",
              id: "call_weather_0",
              name: "get_weather",
              input: { city: "Melbourne" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_weather_0", content: "18C" }],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather by city.",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      // Anthropic structured-output (issue #59, Theme 3): output_format json_schema
      // round-trips back to an IR response_format on inbound normalization.
      output_format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
    };
  }

  if (protocol === "responses") {
    return {
      model: "matrix-model",
      instructions: "Be precise.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Describe this image and call the tool." },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
        {
          type: "function_call",
          call_id: "call_weather_0",
          name: "get_weather",
          arguments: '{"city":"Melbourne"}',
        },
        { type: "function_call_output", call_id: "call_weather_0", output: "18C" },
      ],
      tools: canonicalRequestIR.tools,
      tool_choice: "auto",
      // Responses carries structured output under `text`; the inbound normalizer
      // maps it to IR.response_format (so responses-as-SOURCE json-schema works).
      text: {
        format: {
          type: "json_schema",
          name: "weather_answer",
          schema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
        },
      },
      stream: true,
    };
  }

  return {
    systemInstruction: { parts: [{ text: "Be precise." }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: "Describe this image and call the tool." },
          { inlineData: { mimeType: "image/png", data: "AAAA" } },
        ],
      },
      {
        role: "model",
        parts: [
          { text: "Calling weather." },
          { functionCall: { name: "get_weather", args: { city: "Melbourne" } } },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_weather", response: { content: "18C" } } }],
      },
    ],
    tools: [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather by city.",
            parameters: {
              type: "object",
              properties: { city: { type: "string", format: "city-name" } },
              required: ["city"],
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  };
}

function nativeResponse(protocol: ProtocolName): unknown {
  if (protocol === "openai") {
    return {
      id: "matrix-openai-response",
      model: "matrix-model",
      choices: [
        {
          index: 0,
          message: canonicalResponseIR.choices[0]?.message,
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 13,
        completion_tokens: 4,
        total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    };
  }

  if (protocol === "gemini") {
    return {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "Here is the answer." },
              { functionCall: { name: "get_weather", args: { city: "Melbourne" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 13,
        cachedContentTokenCount: 3,
        candidatesTokenCount: 4,
        totalTokenCount: 17,
      },
    };
  }

  if (protocol === "responses") {
    // Responses input_tokens is the FULL prompt (incl cache); the IR normalizer
    // subtracts cached -> prompt_tokens=10, cached_tokens=3 (non-double-billed).
    return {
      id: "matrix-responses-response",
      object: "response",
      model: "matrix-model",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Here is the answer." }],
        },
        {
          type: "function_call",
          call_id: "call_weather_0",
          name: "get_weather",
          arguments: '{"city":"Melbourne"}',
        },
      ],
      usage: {
        input_tokens: 13,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 3 },
      },
    };
  }

  if (protocol === "anthropic") {
    // Anthropic input_tokens is ALREADY the non-cached input, so input_tokens=10
    // maps straight to IR prompt_tokens=10 and cache_read_input_tokens=3 ->
    // cached_tokens=3 (the canonical IR's expected non-double-billed usage).
    return {
      id: "matrix-anthropic-response",
      type: "message",
      role: "assistant",
      model: "matrix-model",
      content: [
        { type: "text", text: "Here is the answer." },
        {
          type: "tool_use",
          id: "call_weather_0",
          name: "get_weather",
          input: { city: "Melbourne" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
    };
  }

  return undefined;
}

function hasPassingFixture(path: ProtocolMatrixPath, dimension: ProtocolMatrixDimension): boolean {
  return path.fixtures.some(
    (fixture) => fixture.dimension === dimension && fixture.status === "passing",
  );
}

function expectSerializedField(value: unknown, field: string): void {
  expect(JSON.stringify(value)).toContain(`"${field}"`);
}

function expectIrToolCall(ir: IRRequest | IRResponse): void {
  const serialized = JSON.stringify(ir);
  expectSerializedField(ir, "tool_calls");
  expect(serialized).toContain("get_weather");
  expect(serialized).toContain("Melbourne");
}

function expectIrImageDataUrl(ir: IRRequest): void {
  expect(JSON.stringify(ir)).toContain("data:image/png;base64,AAAA");
}

function expectIrUsageNotDoubleBilled(ir: IRResponse): void {
  expect(ir.usage?.prompt_tokens).toBe(10);
  expect(ir.usage?.cached_tokens).toBe(3);
  expect(ir.usage?.completion_tokens).toBe(4);
}

function expectTargetToolCall(protocol: ProtocolName, native: unknown): void {
  const serialized = JSON.stringify(native);
  expect(serialized).toContain("get_weather");
  expect(serialized).toContain("Melbourne");
  if (protocol === "openai") expectSerializedField(native, "tool_calls");
  if (protocol === "anthropic") expect(serialized).toContain("tool_use");
  if (protocol === "gemini") expectSerializedField(native, "functionCall");
  if (protocol === "responses") expectSerializedField(native, "function_call");
}

function expectTargetUsageNotDoubleBilled(protocol: ProtocolName, native: unknown): void {
  const serialized = JSON.stringify(native);
  if (protocol === "openai") {
    expect(serialized).toContain('"prompt_tokens":13');
    expect(serialized).toContain('"completion_tokens":4');
    expect(serialized).toContain('"cached_tokens":3');
  }
  if (protocol === "anthropic") {
    expect(serialized).toContain('"input_tokens":10');
    expect(serialized).toContain('"output_tokens":4');
    expect(serialized).toContain('"cache_read_input_tokens":3');
  }
  if (protocol === "gemini") {
    expect(serialized).toContain('"promptTokenCount":13');
    expect(serialized).toContain('"candidatesTokenCount":4');
    expect(serialized).toContain('"cachedContentTokenCount":3');
    expect(serialized).toContain('"totalTokenCount":17');
  }
  if (protocol === "responses") {
    // The Responses renderer reports the FULL input (13 = 10 non-cached + 3 cached)
    // with the cached split on input_tokens_details — parallel to openai/gemini, and
    // matching the Responses API's own input_tokens_details.cached_tokens. Cache is
    // shown for transparency, never double-billed (the 3 is part of the 13). (order 21)
    expect(serialized).toContain('"input_tokens":13');
    expect(serialized).toContain('"output_tokens":4');
    expect(serialized).toContain('"cached_tokens":3');
  }
}

describe("protocol cross-path fixture matrix", () => {
  it("documents LiteLLM provenance without vendoring code", () => {
    expect(protocolMatrixProvenance).toContain("behavior/checklist");
    expect(protocolMatrixProvenance).toContain("no LiteLLM code is copied");
  });

  it("covers all 16 round-trip paths (4 protocols incl identity/self)", () => {
    const expected = new Set<string>();
    for (const from of protocols) for (const to of protocols) expected.add(`${from}->${to}`);
    const actual = new Set(protocolMatrix.map((entry) => `${entry.from}->${entry.to}`));

    expect(expected.size).toBe(16);
    expect(actual).toEqual(expected);
  });

  it("splits the matrix into 12 cross paths + 4 identity paths", () => {
    expect(protocolCrossPathMatrix).toHaveLength(12);
    expect(protocolIdentityMatrix).toHaveLength(4);
    for (const p of protocolCrossPathMatrix) expect(p.from).not.toBe(p.to);
    for (const p of protocolIdentityMatrix) expect(p.from).toBe(p.to);
    // identity paths cover exactly one self-path per protocol.
    expect(new Set(protocolIdentityMatrix.map((p) => p.from))).toEqual(new Set(protocols));
  });

  it("covers every required dimension on every path", () => {
    for (const path of protocolMatrix) {
      const dimensions = new Set(path.fixtures.map((fixture) => fixture.dimension));
      expect(dimensions).toEqual(new Set(protocolMatrixDimensions));
      expect(path.fixtures).toHaveLength(protocolMatrixDimensions.length);
    }
  });

  it("keeps todo/failing coverage explicit instead of silently passing gaps", () => {
    const todos = protocolMatrix.flatMap((path) =>
      path.fixtures.filter((fixture) => fixture.status === "todo"),
    );
    expect(todos.length).toBeGreaterThan(0);
    for (const fixture of todos) {
      expect(fixture.todoReason).toBeDefined();
      expect(fixture.todoReason?.length).toBeGreaterThan(20);
    }
  });

  it("uses unique fixture ids so future golden files can target one gap at a time", () => {
    const ids = protocolMatrix.flatMap((path) =>
      path.fixtures.map((fixture) => `${path.from}->${path.to}:${fixture.id}`),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("protocol cross-path executable harness", () => {
  it.each(
    protocolMatrix,
  )("normalizes $from requests to IR before any target nativeOut checks", async ({ from }) => {
    const ir = await requestOut[from](nativeRequest(from));
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    expect(ir.messages.length).toBeGreaterThan(0);
  });

  it.each(
    protocolMatrix.filter((path) => requestIn[path.to] !== undefined),
  )("converts $from request IR to $to native request without leaking provider_raw", async ({
    from,
    to,
  }) => {
    const ir = await requestOut[from](nativeRequest(from));
    const toNative = requestIn[to];
    expect(toNative).toBeDefined();
    const native = await toNative?.(ir);

    expect(native).toBeDefined();
    expect(JSON.stringify(native)).not.toContain("provider_raw");
  });

  it.each(
    protocolMatrix.filter((path) => hasPassingFixture(path, "tool-call")),
  )("guards passing tool-call fixtures for $from->$to", async ({ from, to }) => {
    const ir = await requestOut[from](nativeRequest(from));
    expectIrToolCall(ir);

    const native = await responseOut[to](canonicalResponseIR);
    expectTargetToolCall(to, native);
  });

  it.each(
    protocolMatrix.filter((path) => hasPassingFixture(path, "multimodal")),
  )("guards passing multimodal fixtures for $from->$to", async ({ from, to }) => {
    const ir = await requestOut[from](nativeRequest(from));
    expectIrImageDataUrl(ir);

    const toNative = requestIn[to];
    if (toNative !== undefined) {
      const native = await toNative(ir);
      if (to === "openai") expect(JSON.stringify(native)).toContain("data:image/png;base64,AAAA");
      if (to === "gemini") expectSerializedField(native, "inlineData");
      if (to === "anthropic") {
        // Inline data-url collapses back into an Anthropic base64 image source.
        const serialized = JSON.stringify(native);
        expectSerializedField(native, "source");
        expect(serialized).toContain('"base64"');
        expect(serialized).toContain("AAAA");
      }
    }
  });

  it.each(
    protocolMatrix.filter((path) => hasPassingFixture(path, "json-schema")),
  )("guards passing JSON schema fixtures for $from->$to", async ({ from, to }) => {
    const ir = await requestOut[from](nativeRequest(from));
    expect(ir.response_format).toBeDefined();
    expect(JSON.stringify(ir.response_format)).toContain("summary");

    const toNative = requestIn[to];
    expect(toNative).toBeDefined();
    const native = await toNative?.(ir);
    if (to === "gemini") expectSerializedField(native, "responseSchema");
    else if (to === "anthropic") expectSerializedField(native, "output_format");
    else expectSerializedField(native, "response_format");
    expect(JSON.stringify(native)).toContain("summary");
  });

  it.each(
    protocolMatrix,
  )("renders canonical IR responses as $to native responses for $from->$to", async ({ to }) => {
    const native = await responseOut[to](canonicalResponseIR);
    const serialized = JSON.stringify(native);
    expect(native).toBeDefined();
    expect(serialized).toContain("Here is the answer");
  });

  it.each(
    protocolMatrix.filter((path) => hasPassingFixture(path, "response")),
  )("guards passing response fixtures for $from->$to", async ({ to }) => {
    const native = await responseOut[to](canonicalResponseIR);
    expectTargetToolCall(to, native);
    expectTargetUsageNotDoubleBilled(to, native);
  });

  it.each(
    protocolMatrix.filter((path) => hasPassingFixture(path, "usage")),
  )("guards passing usage fixtures for $from->$to", async ({ from, to }) => {
    const source = nativeResponse(from);
    const toIr = responseInBySource[from];
    if (source !== undefined && toIr !== undefined) {
      const ir = await toIr(source);
      expectIrUsageNotDoubleBilled(ir);
    }

    const native = await responseOut[to](canonicalResponseIR);
    expectTargetUsageNotDoubleBilled(to, native);
  });

  it.each(
    protocolMatrix.filter((path) => nativeResponse(path.from) !== undefined),
  )("normalizes $from provider-native responses before rendering $to native responses", async ({
    from,
    to,
  }) => {
    const source = nativeResponse(from);
    const toIr = responseInBySource[from];
    expect(toIr).toBeDefined();
    const ir = await toIr?.(source);
    expect(ir).toBeDefined();
    if (ir === undefined) return;
    expect(() => IRResponseSchema.parse(ir)).not.toThrow();

    const native = await responseOut[to](ir);
    const serialized = JSON.stringify(native);
    expect(native).toBeDefined();
    expect(serialized).toContain("Here is the answer");
  });

  it("renders OpenAI-style streaming chunks to Anthropic and Gemini target streams", async () => {
    const chunks: GeminiIRChunk[] = [
      {
        id: "chatcmpl-matrix",
        model: "matrix-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
      },
      {
        id: "chatcmpl-matrix",
        model: "matrix-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_weather_0",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city"' },
                },
              ],
            },
          },
        ],
      },
      {
        id: "chatcmpl-matrix",
        model: "matrix-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ':"Melbourne"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4, cached_tokens: 3 },
      },
    ];

    const anthropicEvents = await collect(convertOpenAIStreamToAnthropic(fromArray(chunks)));
    const geminiEvents = await collect(geminiTransformer.transformStreamOut(fromArray(chunks)));

    const anthropicSerialized = JSON.stringify(anthropicEvents);
    const geminiSerialized = JSON.stringify(geminiEvents);

    expect(anthropicEvents.map((event) => event.type)).toContain("message_stop");
    expect(anthropicSerialized).toContain("input_json_delta");
    expect(anthropicSerialized).toContain("tool_use");
    expect(anthropicSerialized).toContain("get_weather");
    expect(anthropicSerialized).toContain("Melbourne");
    expect(anthropicSerialized).toContain('"input_tokens":7');
    expect(anthropicSerialized).toContain('"cache_read_input_tokens":3');
    expect(geminiEvents.at(-1)?.usageMetadata?.promptTokenCount).toBe(10);
    expect(geminiSerialized).toContain("functionCall");
    expect(geminiSerialized).toContain("get_weather");
    expect(geminiSerialized).toContain("Melbourne");
    expect(geminiSerialized).not.toContain("[DONE]");
  });

  // Theme 4 (issue #59): a GEMINI snapshot stream driven through the source
  // normalizer (snapshot -> IR chunks) then re-serialized for the OpenAI and
  // Anthropic target wire shapes. The IR chunk IS the OpenAI chunk shape, so the
  // OpenAI serializer is a thin identity wrapper + a [DONE] sentinel; the Anthropic
  // path composes the same IR chunks through convertOpenAIStreamToAnthropic.
  it("normalizes a Gemini snapshot stream and re-serializes to OpenAI and Anthropic targets", async () => {
    // Gemini ?alt=sse emits FULL-snapshot events; text accumulates, functionCall
    // args carry the current complete object on each snapshot.
    const geminiSnapshots: GeminiSSEEvent[] = [
      {
        modelVersion: "matrix-model",
        candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }],
      },
      {
        modelVersion: "matrix-model",
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "Hello" },
                { functionCall: { name: "get_weather", args: { city: "Melbourne" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 13,
          cachedContentTokenCount: 3,
          candidatesTokenCount: 4,
          totalTokenCount: 17,
        },
      },
    ];

    const irChunks = await collect(geminiTransformer.transformStreamIn(fromArray(geminiSnapshots)));

    // gemini -> openai: identity serialize the IR chunks as chat.completion.chunk
    // SSE plus the terminal [DONE] sentinel (the only OpenAI-specific framing).
    const openaiSse = [
      ...irChunks.map(
        (chunk) => `data: ${JSON.stringify({ object: "chat.completion.chunk", ...chunk })}\n\n`,
      ),
      "data: [DONE]\n\n",
    ];
    const openaiJoined = openaiSse.join("");
    expect(openaiJoined).toContain("chat.completion.chunk");
    expect(openaiJoined).toContain("Hello");
    expect(openaiJoined).toContain("get_weather");
    expect(openaiJoined).toContain("Melbourne");
    expect(openaiJoined.endsWith("data: [DONE]\n\n")).toBe(true);

    // gemini -> anthropic: feed the same IR chunks into the Anthropic SSE producer.
    const anthropicEvents = await collect(convertOpenAIStreamToAnthropic(fromArray(irChunks)));
    const anthropicSerialized = JSON.stringify(anthropicEvents);
    expect(anthropicEvents.map((e) => e.type)).toContain("message_start");
    expect(anthropicEvents.map((e) => e.type)).toContain("message_stop");
    expect(anthropicSerialized).toContain("tool_use");
    expect(anthropicSerialized).toContain("get_weather");
    expect(anthropicSerialized).toContain("Melbourne");
    expect(anthropicSerialized).not.toContain("[DONE]");
  });

  // Theme 2 (issue #59): a native ANTHROPIC SSE stream normalized to IR chunks via
  // the new convertAnthropicStreamToIR, then re-serialized for the OpenAI and Gemini
  // targets — exercising the anthropic->openai and anthropic->gemini streaming paths.
  it("normalizes a native Anthropic SSE stream and re-serializes to OpenAI and Gemini targets", async () => {
    const anthropicStream: AnthropicSSEEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_matrix",
          type: "message",
          role: "assistant",
          model: "matrix-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // REAL Anthropic wire shape: the prompt usage (input + cache) is reported
          // up-front on message_start; message_delta later carries only output.
          usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_weather_0", name: "get_weather", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":"Melbourne"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        // REAL Anthropic message_delta carries ONLY the cumulative output_tokens.
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ];

    const irChunks = await collect(
      anthropicTransformer.transformStreamIn(fromArray(anthropicStream)),
    );
    const irSerialized = JSON.stringify(irChunks);
    expect(irSerialized).toContain("Hello");
    expect(irSerialized).toContain("get_weather");
    expect(irSerialized).toContain("Melbourne");
    // terminal IR chunk carries the reverse-mapped finish_reason + non-double-billed usage.
    const terminal = irChunks.at(-1);
    expect(terminal?.choices?.[0]?.finish_reason).toBe("tool_calls");
    // input from message_start, output from message_delta, cache from message_start.
    expect(terminal?.usage?.prompt_tokens).toBe(10);
    expect(terminal?.usage?.completion_tokens).toBe(4);
    expect(terminal?.usage?.cached_tokens).toBe(3);

    // anthropic -> gemini: re-serialize the IR chunks to Gemini snapshots.
    const geminiEvents = await collect(geminiTransformer.transformStreamOut(fromArray(irChunks)));
    const geminiSerialized = JSON.stringify(geminiEvents);
    expect(geminiSerialized).toContain("functionCall");
    expect(geminiSerialized).toContain("get_weather");
    expect(geminiSerialized).toContain("Melbourne");
  });

  // SCOPE (issue #51, P2): the error dimension verifies that the TARGET protocol
  // can render a Helm error into its own native envelope — it deliberately does
  // NOT exercise a source-protocol-specific failure path. A provider's native
  // error -> Helm ErrorClass classification happens at the executor / circuit
  // layer (see provider/* + the gateway routes), not in these pure renderers, so
  // the matrix asserts on `to` only. Each target is checked against MULTIPLE
  // classes so the whole map is exercised, not one synthetic value.
  const ERROR_RENDER_EXPECTATIONS: Record<
    ProtocolName,
    Array<{ cls: ErrorClass; status: number; body: unknown }>
  > = {
    anthropic: [
      {
        cls: "rate_limited",
        status: 429,
        body: { type: "error", error: { type: "rate_limit_error", message: "matrix err" } },
      },
      {
        cls: "auth_error",
        status: 401,
        body: { type: "error", error: { type: "authentication_error", message: "matrix err" } },
      },
    ],
    openai: [
      {
        cls: "rate_limited",
        status: 429,
        body: {
          error: {
            message: "matrix err",
            type: "rate_limit_error",
            code: "rate_limited",
            // trace_id is carried ON the wire by the OpenAI contract (docs/07).
            trace_id: "trace-matrix",
          },
        },
      },
      {
        cls: "auth_error",
        status: 401,
        body: {
          error: {
            message: "matrix err",
            type: "invalid_request_error",
            code: "invalid_api_key",
            trace_id: "trace-matrix",
          },
        },
      },
    ],
    gemini: [
      {
        cls: "rate_limited",
        status: 429,
        body: { error: { code: 429, message: "matrix err", status: "RESOURCE_EXHAUSTED" } },
      },
      {
        cls: "auth_error",
        status: 401,
        body: { error: { code: 401, message: "matrix err", status: "UNAUTHENTICATED" } },
      },
    ],
    // Responses is OpenAI's own protocol, so it shares the OpenAI error envelope
    // (including the on-wire trace_id, docs/07).
    responses: [
      {
        cls: "rate_limited",
        status: 429,
        body: {
          error: {
            message: "matrix err",
            type: "rate_limit_error",
            code: "rate_limited",
            trace_id: "trace-matrix",
          },
        },
      },
      {
        cls: "auth_error",
        status: 401,
        body: {
          error: {
            message: "matrix err",
            type: "invalid_request_error",
            code: "invalid_api_key",
            trace_id: "trace-matrix",
          },
        },
      },
    ],
  };

  const renderError: Record<ProtocolName, (helm: ReturnType<typeof makeHelmError>) => unknown> = {
    anthropic: (helm) => transformAnthropicErrorOut(helm),
    openai: (helm) => transformOpenAIErrorOut(helm),
    gemini: (helm) => transformGeminiErrorOut(helm),
    responses: (helm) => transformOpenAIErrorOut(helm),
  };

  it.each(
    protocolMatrix.filter((path) => hasPassingFixture(path, "error")),
  )("renders Helm errors into the $to native envelope (target-renderer; source $from is incidental)", ({
    to,
  }) => {
    for (const { cls, status, body } of ERROR_RENDER_EXPECTATIONS[to]) {
      const helm = makeHelmError({
        error_class: cls,
        message: "matrix err",
        trace_id: "trace-matrix",
      });
      const out = renderError[to](helm) as { status: number; body: unknown };
      expect(out.status).toBe(status);
      expect(out.body).toEqual(body);
    }

    // Anthropic/Gemini native shapes have no trace_id field; OpenAI carries it by
    // contract. Assert the non-OpenAI targets do not smuggle the trace id onto the
    // wire (principle 7), while OpenAI exposes it intentionally.
    const probe = makeHelmError({
      error_class: "rate_limited",
      message: "matrix err",
      trace_id: "trace-matrix",
    });
    const rendered = renderError[to](probe) as { body: unknown };
    if (to === "openai" || to === "responses") {
      expect(JSON.stringify(rendered.body)).toContain("trace-matrix");
    } else {
      expect(JSON.stringify(rendered.body)).not.toContain("trace-matrix");
    }
  });
});

// Focused cross-path check for the developer role (issue #50). Intentionally NOT
// a new matrix dimension — protocolMatrixDimensions stays untouched so the
// "every path has every dimension" invariant above still holds.
describe("developer-role cross-path fold (issue #50)", () => {
  it("OpenAI developer+system+user -> Gemini native folds both into systemInstruction in order", async () => {
    const native = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Be precise." },
        { role: "developer", content: "Prefer metric units." },
        { role: "user", content: "weather in SF?" },
      ],
    };
    const ir = await requestOut.openai(native);
    expect(ir.messages.map((m) => m.role)).toEqual(["system", "developer", "user"]);

    const gemini = (await requestIn.gemini?.(ir)) as {
      systemInstruction?: { parts: Array<{ text?: string }> };
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
    };
    const sysText = (gemini.systemInstruction?.parts ?? []).map((p) => p.text ?? "").join("");
    expect(sysText).toBe("Be precise.\n\nPrefer metric units.");

    // Only the user turn survives in contents — no developer/system leakage.
    expect(gemini.contents).toHaveLength(1);
    expect(gemini.contents[0]?.role).toBe("user");
    expect(JSON.stringify(gemini.contents)).not.toContain("Prefer metric units.");
  });
});

// Focused cross-path check for reasoning/thinking (P6). Intentionally NOT a new
// matrix dimension — protocolMatrixDimensions stays untouched so the "every path
// has every dimension" invariant above still holds. A single reasoning-bearing IR
// is rendered into each target's NATIVE thinking surface, asserting reasoning is
// never dropped (gemini outbound) nor leaked into visible text (openai outbound).
describe("reasoning cross-path render (P6)", () => {
  // Each target reads reasoning from the IR (content-block thinking part + flat
  // reasoning_content/thinking_blocks) and renders it into its native surface.
  const reasoningSurface: Record<ProtocolName, (native: unknown) => boolean> = {
    // OpenAI: flat message.reasoning_content, NOT a thinking content block.
    openai: (native) => {
      const r = native as {
        choices: Array<{ message: { content: unknown; reasoning_content?: string } }>;
      };
      const msg = r.choices[0]?.message;
      const contentOk = !JSON.stringify(msg?.content ?? "").includes("thinking");
      return msg?.reasoning_content === "Reasoning step." && contentOk;
    },
    // Anthropic: a thinking content block with the preserved signature.
    anthropic: (native) => {
      const r = native as {
        content: Array<{ type: string; thinking?: string; signature?: string }>;
      };
      const t = r.content.find((b) => b.type === "thinking");
      return t?.thinking === "Reasoning step." && t?.signature === "sig-matrix";
    },
    // Gemini: a thought part (thought:true) carrying the reasoning text.
    gemini: (native) => {
      const r = native as {
        candidates: Array<{ content: { parts: Array<{ text?: string; thought?: boolean }> } }>;
      };
      const parts = r.candidates[0]?.content.parts ?? [];
      return parts.some((p) => p.thought === true && p.text === "Reasoning step.");
    },
    // Responses: a `reasoning` output item carrying the reasoning as summary_text,
    // emitted BEFORE the answer message (reasoning precedes the answer).
    responses: (native) => {
      const r = native as {
        output: Array<{ type: string; summary?: Array<{ type?: string; text?: string }> }>;
      };
      const item = r.output.find((o) => o.type === "reasoning");
      return (item?.summary ?? []).some((s) => s.text === "Reasoning step.");
    },
  };

  it.each(
    protocols,
  )("renders the canonical reasoning IR into %s native thinking surface", async (to) => {
    const native = await responseOut[to](canonicalReasoningResponseIR);
    // The visible answer is always present.
    expect(JSON.stringify(native)).toContain("Here is the answer.");
    expect(reasoningSurface[to](native)).toBe(true);
  });

  it.each(
    protocols,
  )("round-trips reasoning %s native -> IR -> openai reasoning_content", async (from) => {
    // Render the canonical reasoning IR to `from`'s native shape, normalize it BACK
    // to IR, then to OpenAI — reasoning must survive the full nativeIn->IR->nativeOut.
    const native = await responseOut[from](canonicalReasoningResponseIR);
    const toIr = responseInBySource[from];
    expect(toIr).toBeDefined();
    const ir = await toIr?.(native);
    expect(ir).toBeDefined();
    if (ir === undefined) return;
    expect(ir.choices[0]?.message.reasoning_content).toContain("Reasoning step.");

    const oai = (await responseOut.openai(ir)) as {
      choices: Array<{ message: { content: unknown; reasoning_content?: string } }>;
    };
    expect(oai.choices[0]?.message.reasoning_content).toContain("Reasoning step.");
    expect(JSON.stringify(oai.choices[0]?.message.content ?? "")).not.toContain("thinking");
  });
});

// Focused cross-path check for citations/annotations (P8). The IR carries citations
// on message.annotations (the OpenAI url_citation shape; Gemini grounding folds in on
// inbound). OpenAI's IR->native renderer re-emits them natively; Anthropic/Gemini/
// Responses have no native annotation re-render today, so the matrix DOCUMENTS that
// gap here rather than silently dropping it. Not a new matrix dimension.
describe("citations/annotations cross-path render (P8)", () => {
  // Which targets re-emit IR annotations onto their native wire (true) vs. drop them
  // as a documented gap until a native citation re-render exists (false).
  const ANNOTATION_NATIVE_SURFACE: Record<ProtocolName, boolean> = {
    openai: true,
    // order 20: Responses now re-emits annotations natively onto the output_text part.
    responses: true,
    anthropic: false,
    gemini: false,
  };

  it("preserves a url_citation through openai nativeIn -> IR -> openai nativeOut", async () => {
    // OpenAI source -> IR keeps annotations on the assistant message.
    const native = (await responseOut.openai(canonicalAnnotationResponseIR)) as {
      choices: Array<{ message: { annotations?: Array<{ type: string; url?: string }> } }>;
    };
    const ann = native.choices[0]?.message.annotations;
    expect(ann?.[0]?.type).toBe("url_citation");
    expect(ann?.[0]?.url).toBe("https://example.com/au");
  });

  it.each(
    protocols,
  )("renders the canonical annotation IR into %s (native surface OR documented gap)", async (to) => {
    const native = await responseOut[to](canonicalAnnotationResponseIR);
    const serialized = JSON.stringify(native);
    // The visible answer always survives regardless of citation support.
    expect(serialized).toContain("Sydney is in Australia.");
    if (ANNOTATION_NATIVE_SURFACE[to]) {
      expect(serialized).toContain("url_citation");
      expect(serialized).toContain("https://example.com/au");
    } else {
      // Documented gap: the target has no native annotation re-render yet, so the
      // citation is intentionally absent from its native wire shape (no silent
      // half-rendered shape). It survives losslessly on the IR for OpenAI clients.
      expect(serialized).not.toContain("url_citation");
    }
  });
});

// Focused cross-path check for usage detail (P8): reasoning_tokens / cache_creation_
// tokens / cached_tokens must survive each source's nativeIn -> IR normalization
// without double-billing the cached split, OR be documented. Not a new dimension.
describe("usage-detail cross-path normalization (P8)", () => {
  // Per-source provider-native responses carrying the FULL usage detail surface.
  function nativeUsageResponse(from: ProtocolName): unknown | undefined {
    if (from === "openai") {
      return {
        id: "u-openai",
        model: "matrix-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 13,
          completion_tokens: 9,
          total_tokens: 22,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      };
    }
    if (from === "gemini") {
      return {
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 13,
          cachedContentTokenCount: 3,
          candidatesTokenCount: 9,
          thoughtsTokenCount: 5,
          totalTokenCount: 22,
        },
      };
    }
    if (from === "anthropic") {
      return {
        id: "u-anthropic",
        type: "message",
        role: "assistant",
        model: "matrix-model",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        // Anthropic reports non-cached input + a cache read + a cache CREATION write.
        usage: {
          input_tokens: 10,
          output_tokens: 9,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 7,
        },
      };
    }
    if (from === "responses") {
      return {
        id: "u-responses",
        object: "response",
        model: "matrix-model",
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        ],
        usage: {
          input_tokens: 13,
          output_tokens: 9,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      };
    }
    return undefined;
  }

  it.each(
    protocols,
  )("normalizes %s usage detail to IR without double-billing the cached split", async (from) => {
    const native = nativeUsageResponse(from);
    const toIr = responseInBySource[from];
    expect(native).toBeDefined();
    expect(toIr).toBeDefined();
    const ir = await toIr?.(native);
    expect(ir).toBeDefined();
    if (ir === undefined) return;

    // Non-cached prompt + cached split is consistent across every source.
    expect(ir.usage?.prompt_tokens).toBe(10);
    expect(ir.usage?.cached_tokens).toBe(3);
    expect(ir.usage?.completion_tokens).toBe(9);

    // reasoning_tokens surfaces for the sources that report it (Anthropic's usage has
    // no reasoning split — it reports a cache CREATION write instead).
    if (from === "anthropic") {
      expect(ir.usage?.cache_creation_tokens).toBe(7);
    } else {
      expect(ir.usage?.reasoning_tokens).toBe(5);
    }
  });
});
