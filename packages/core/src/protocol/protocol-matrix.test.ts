import { makeHelmError } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  anthropicTransformer,
  convertOpenAIStreamToAnthropic,
  transformErrorOut as transformAnthropicErrorOut,
} from "./anthropic/index.js";
import { geminiTransformer } from "./gemini/gemini-transformer.js";
import type { IRChunk as GeminiIRChunk } from "./gemini/gemini-types.js";
import type { IRRequest, IRResponse } from "./ir.js";
import { IRRequestSchema, IRResponseSchema } from "./ir.js";
import { openaiTransformer } from "./openai.js";
import {
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
  gemini: (ir) => geminiTransformer.transformRequestIn(ir),
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
    if (source !== undefined) {
      const ir =
        from === "openai"
          ? await openaiTransformer.transformResponseIn(source)
          : await geminiTransformer.transformResponseIn(source);
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
    const ir =
      from === "openai"
        ? await openaiTransformer.transformResponseIn(source)
        : await geminiTransformer.transformResponseIn(source);
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

  it.each(
    protocolCrossPathMatrix.filter((path) => hasPassingFixture(path, "error")),
  )("guards passing error fixtures for $from->$to", ({ to }) => {
    expect(to).toBe("anthropic");
    const out = transformAnthropicErrorOut(
      makeHelmError({
        error_class: "rate_limited",
        message: "matrix rate limit",
        trace_id: "trace-matrix",
      }),
    );

    expect(out.status).toBe(429);
    expect(out.body).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "matrix rate limit" },
    });
  });
});
