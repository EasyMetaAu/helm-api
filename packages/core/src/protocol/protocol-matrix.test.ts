import { describe, expect, it } from "vitest";
import { anthropicTransformer, convertOpenAIStreamToAnthropic } from "./anthropic/index.js";
import { geminiTransformer } from "./gemini/gemini-transformer.js";
import type { IRChunk as GeminiIRChunk } from "./gemini/gemini-types.js";
import type { IRRequest, IRResponse } from "./ir.js";
import { IRRequestSchema, IRResponseSchema } from "./ir.js";
import { openaiTransformer } from "./openai.js";
import {
  canonicalRequestIR,
  canonicalResponseIR,
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
    protocolCrossPathMatrix,
  )("renders canonical IR responses as $to native responses for $from->$to", async ({ to }) => {
    const native = await responseOut[to](canonicalResponseIR);
    const serialized = JSON.stringify(native);
    expect(native).toBeDefined();
    expect(serialized).toContain("Here is the answer");
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

    expect(anthropicEvents.map((event) => event.type)).toContain("message_stop");
    expect(JSON.stringify(anthropicEvents)).toContain("input_json_delta");
    expect(geminiEvents.at(-1)?.usageMetadata?.promptTokenCount).toBe(10);
    expect(JSON.stringify(geminiEvents)).not.toContain("[DONE]");
  });
});
