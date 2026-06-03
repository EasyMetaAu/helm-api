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
  canonicalReasoningResponseIR,
  canonicalRequestIR,
  canonicalResponseIR,
  type ProtocolMatrixDimension,
  type ProtocolMatrixPath,
  type ProtocolName,
  protocolCrossPathMatrix,
  protocolMatrixDimensions,
  protocolMatrixProvenance,
  protocols,
} from "./protocol-matrix.fixtures.js";
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
};

const responseOut: Record<ProtocolName, (ir: IRResponse) => unknown | Promise<unknown>> = {
  openai: (ir) => openaiTransformer.transformResponseOut(ir),
  anthropic: (ir) => anthropicTransformer.transformResponseOut(ir),
  gemini: (ir) => geminiTransformer.transformResponseOut(ir),
};

const requestIn: Partial<Record<ProtocolName, Transformer["transformRequestIn"]>> = {
  openai: (ir) => openaiTransformer.transformRequestIn(ir),
  anthropic: (ir) => anthropicTransformer.transformRequestIn(ir),
  gemini: (ir) => geminiTransformer.transformRequestIn(ir),
};

// Provider-native response -> IR, per source protocol. anthropic joins openai/gemini
// now that the Anthropic transformer is bidirectional (issue #59, Theme 2).
const responseInBySource: Partial<
  Record<ProtocolName, (native: unknown) => IRResponse | Promise<IRResponse>>
> = {
  openai: (native) => openaiTransformer.transformResponseIn(native),
  anthropic: (native) => anthropicTransformer.transformResponseIn(native),
  gemini: (native) => geminiTransformer.transformResponseIn(native),
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
}

describe("protocol cross-path fixture matrix", () => {
  it("documents LiteLLM provenance without vendoring code", () => {
    expect(protocolMatrixProvenance).toContain("behavior/checklist");
    expect(protocolMatrixProvenance).toContain("no LiteLLM code is copied");
  });

  it("covers exactly the six non-identity protocol paths", () => {
    const expected = new Set([
      "openai->anthropic",
      "anthropic->openai",
      "openai->gemini",
      "gemini->openai",
      "anthropic->gemini",
      "gemini->anthropic",
    ]);
    const actual = new Set(protocolCrossPathMatrix.map((entry) => `${entry.from}->${entry.to}`));

    expect(actual).toEqual(expected);
    for (const protocol of protocols) {
      expect(actual.has(`${protocol}->${protocol}`)).toBe(false);
    }
  });

  it("covers every required dimension on every path", () => {
    for (const path of protocolCrossPathMatrix) {
      const dimensions = new Set(path.fixtures.map((fixture) => fixture.dimension));
      expect(dimensions).toEqual(new Set(protocolMatrixDimensions));
      expect(path.fixtures).toHaveLength(protocolMatrixDimensions.length);
    }
  });

  it("keeps todo/failing coverage explicit instead of silently passing gaps", () => {
    const todos = protocolCrossPathMatrix.flatMap((path) =>
      path.fixtures.filter((fixture) => fixture.status === "todo"),
    );
    expect(todos.length).toBeGreaterThan(0);
    for (const fixture of todos) {
      expect(fixture.todoReason).toBeDefined();
      expect(fixture.todoReason?.length).toBeGreaterThan(20);
    }
  });

  it("uses unique fixture ids so future golden files can target one gap at a time", () => {
    const ids = protocolCrossPathMatrix.flatMap((path) =>
      path.fixtures.map((fixture) => `${path.from}->${path.to}:${fixture.id}`),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("protocol cross-path executable harness", () => {
  it.each(
    protocolCrossPathMatrix,
  )("normalizes $from requests to IR before any target nativeOut checks", async ({ from }) => {
    const ir = await requestOut[from](nativeRequest(from));
    expect(() => IRRequestSchema.parse(ir)).not.toThrow();
    expect(ir.messages.length).toBeGreaterThan(0);
  });

  it.each(
    protocolCrossPathMatrix.filter((path) => requestIn[path.to] !== undefined),
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
    protocolCrossPathMatrix.filter((path) => hasPassingFixture(path, "tool-call")),
  )("guards passing tool-call fixtures for $from->$to", async ({ from, to }) => {
    const ir = await requestOut[from](nativeRequest(from));
    expectIrToolCall(ir);

    const native = await responseOut[to](canonicalResponseIR);
    expectTargetToolCall(to, native);
  });

  it.each(
    protocolCrossPathMatrix.filter((path) => hasPassingFixture(path, "multimodal")),
  )("guards passing multimodal fixtures for $from->$to", async ({ from, to }) => {
    const ir = await requestOut[from](nativeRequest(from));
    expectIrImageDataUrl(ir);

    const toNative = requestIn[to];
    if (toNative !== undefined) {
      const native = await toNative(ir);
      if (to === "openai") expect(JSON.stringify(native)).toContain("data:image/png;base64,AAAA");
      if (to === "gemini") expectSerializedField(native, "inlineData");
    }
  });

  it.each(
    protocolCrossPathMatrix.filter((path) => hasPassingFixture(path, "json-schema")),
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
    protocolCrossPathMatrix,
  )("renders canonical IR responses as $to native responses for $from->$to", async ({ to }) => {
    const native = await responseOut[to](canonicalResponseIR);
    const serialized = JSON.stringify(native);
    expect(native).toBeDefined();
    expect(serialized).toContain("Here is the answer");
  });

  it.each(
    protocolCrossPathMatrix.filter((path) => hasPassingFixture(path, "response")),
  )("guards passing response fixtures for $from->$to", async ({ to }) => {
    const native = await responseOut[to](canonicalResponseIR);
    expectTargetToolCall(to, native);
    expectTargetUsageNotDoubleBilled(to, native);
  });

  it.each(
    protocolCrossPathMatrix.filter((path) => hasPassingFixture(path, "usage")),
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
    protocolCrossPathMatrix.filter((path) => nativeResponse(path.from) !== undefined),
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
  };

  const renderError: Record<ProtocolName, (helm: ReturnType<typeof makeHelmError>) => unknown> = {
    anthropic: (helm) => transformAnthropicErrorOut(helm),
    openai: (helm) => transformOpenAIErrorOut(helm),
    gemini: (helm) => transformGeminiErrorOut(helm),
  };

  it.each(
    protocolCrossPathMatrix.filter((path) => hasPassingFixture(path, "error")),
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
    if (to === "openai") {
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
