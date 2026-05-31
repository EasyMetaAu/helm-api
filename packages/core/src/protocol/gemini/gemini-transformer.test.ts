import { describe, expect, it } from "vitest";
import type { IRRequest, IRResponse } from "../ir.js";
import {
  GEMINI_API_KEY_HEADER,
  GEMINI_ENDPOINT,
  geminiTransformer,
  parseGeminiPath,
} from "./gemini-transformer.js";
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GeminiSSEEvent,
  IRChunk,
} from "./gemini-types.js";
import { sanitizeSchema } from "./schema-sanitize.js";

// Drain an async iterable into an array (test helper).
async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of src) out.push(x);
  return out;
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) yield x;
}

describe("GeminiTransformer.transformRequestOut (Gemini generateContent -> IR)", () => {
  // test #1: role mapping, systemInstruction hoist, inlineData multimodal.
  it("maps roles, hoists systemInstruction, and converts inlineData images", () => {
    const native: GeminiGenerateContentRequest = {
      systemInstruction: { parts: [{ text: "You are helpful." }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: "Describe this." },
            { inlineData: { mimeType: "image/png", data: "AAAA" } },
          ],
        },
        { role: "model", parts: [{ text: "It is a cat." }] },
      ],
      generationConfig: { maxOutputTokens: 256 },
    };

    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;

    // system hoisted to messages[0]
    expect(ir.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    // user turn with text + image part
    const user = ir.messages[1];
    expect(user?.role).toBe("user");
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content as Array<{ type: string }>;
    expect(parts[0]).toEqual({ type: "text", text: "Describe this." });
    expect(parts[1]).toEqual({
      type: "image",
      url: "data:image/png;base64,AAAA",
      mediaType: "image/png",
    });
    // model -> assistant
    expect(ir.messages[2]?.role).toBe("assistant");
    // generationConfig.maxOutputTokens -> max_tokens
    expect(ir.max_tokens).toBe(256);
  });
});

describe("GeminiTransformer.transformResponseOut (IR -> Gemini response)", () => {
  // test #2: finishReason legal enum + raw in provider_raw; usageMetadata.
  it("maps finishReason to a legal enum, keeps raw, and translates usage", () => {
    const ir: IRResponse = {
      id: "resp_1",
      model: "gemini-1.5-pro",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello there." },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    const native = geminiTransformer.transformResponseOut(ir) as GeminiGenerateContentResponse;

    const cand = native.candidates?.[0];
    expect(cand?.content.role).toBe("model");
    expect(cand?.content.parts[0]).toEqual({ text: "Hello there." });
    // length -> MAX_TOKENS (legal Gemini enum)
    expect(cand?.finishReason).toBe("MAX_TOKENS");
    // usageMetadata translated
    expect(native.usageMetadata?.promptTokenCount).toBe(10);
    expect(native.usageMetadata?.candidatesTokenCount).toBe(5);
    expect(native.usageMetadata?.totalTokenCount).toBe(15);
  });

  it("maps a SAFETY-class finish (content_filter) to SAFETY and keeps raw", () => {
    const ir: IRResponse = {
      id: "r",
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" },
      ],
    };
    const native = geminiTransformer.transformResponseOut(ir) as GeminiGenerateContentResponse;
    expect(native.candidates?.[0]?.finishReason).toBe("SAFETY");
  });
});

describe("GeminiTransformer.transformResponseIn (Gemini response -> IR)", () => {
  it("maps Gemini finishReason STOP->stop and SAFETY->content_filter, raw into provider_raw", () => {
    const native: GeminiGenerateContentResponse = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Hi" }] },
          finishReason: "SAFETY",
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
    };
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.finish_reason).toBe("content_filter");
    expect(ir.provider_raw?.stop_reason).toBe("SAFETY");
    expect(ir.usage?.prompt_tokens).toBe(7);
    expect(ir.usage?.completion_tokens).toBe(3);
  });
});

describe("tool-call id synthesis (the core pit)", () => {
  // test #4: functionCall (no id) -> tool_calls with synthesized id; functionResponse
  // pairs by name; same-name multiple calls don't collide; outbound drops the id.
  it("synthesizes ids for functionCall and backfills the same id on functionResponse", () => {
    const native: GeminiGenerateContentRequest = {
      contents: [
        { role: "user", parts: [{ text: "weather?" }] },
        {
          role: "model",
          parts: [
            { functionCall: { name: "get_weather", args: { city: "SF" } } },
            { functionCall: { name: "get_weather", args: { city: "LA" } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "get_weather", response: { temp: 60 } } },
            { functionResponse: { name: "get_weather", response: { temp: 75 } } },
          ],
        },
      ],
    };

    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;

    const assistant = ir.messages.find((m) => m.role === "assistant");
    const calls = assistant?.tool_calls ?? [];
    expect(calls).toHaveLength(2);
    const id0 = calls[0]?.id as string;
    const id1 = calls[1]?.id as string;
    expect(id0).not.toBe(id1); // same name, distinct ids
    expect(calls[0]?.function.name).toBe("get_weather");
    expect(JSON.parse(calls[0]?.function.arguments ?? "{}")).toEqual({
      city: "SF",
    });

    // functionResponse -> role:"tool" messages, tool_call_id backfilled by name+order
    const toolMsgs = ir.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]?.tool_call_id).toBe(id0);
    expect(toolMsgs[1]?.tool_call_id).toBe(id1);
  });

  it("drops synthesized ids when going IR -> Gemini (outbound)", () => {
    const ir: IRRequest = {
      model: "gemini-1.5-pro",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_get_weather_0",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const part = native.contents[0]?.parts[0];
    expect(part !== undefined && "functionCall" in part).toBe(true);
    const fc = (part as { functionCall: { name: string; args: unknown; id?: string } })
      .functionCall;
    expect(fc.name).toBe("get_weather");
    expect(fc.args).toEqual({ city: "SF" });
    expect("id" in fc).toBe(false); // no synthesized id leaks to Gemini
  });
});

describe("schema format sanitize (date / date-time pit)", () => {
  // test #5: unsupported format stripped; date/date-time downgraded to string.
  it("strips unsupported format and downgrades date/date-time to string", () => {
    const schema = {
      type: "object",
      properties: {
        when: { type: "string", format: "date-time" },
        day: { type: "string", format: "date" },
        email: { type: "string", format: "email" },
        keep: { type: "integer" },
        nested: {
          type: "array",
          items: { type: "string", format: "date" },
        },
      },
    };
    const cleaned = sanitizeSchema(schema) as Record<string, unknown>;
    const props = cleaned.properties as Record<string, Record<string, unknown> | undefined>;
    expect(props.when?.format).toBeUndefined();
    expect(props.when?.type).toBe("string");
    expect(props.day?.format).toBeUndefined();
    expect(props.email?.format).toBeUndefined();
    expect(props.keep?.type).toBe("integer");
    const items = props.nested?.items as Record<string, unknown>;
    expect(items.format).toBeUndefined();
    expect(items.type).toBe("string");
  });

  it("sanitizes functionDeclarations parameters on the outbound request", () => {
    const ir: IRRequest = {
      model: "gemini-1.5-pro",
      messages: [],
      tools: [
        {
          type: "function",
          function: {
            name: "book",
            parameters: {
              type: "object",
              properties: { date: { type: "string", format: "date" } },
            },
          },
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const decl = native.tools?.[0]?.functionDeclarations?.[0];
    const params = decl?.parameters as {
      properties: Record<string, Record<string, unknown> | undefined>;
    };
    expect(params.properties.date?.format).toBeUndefined();
    expect(params.properties.date?.type).toBe("string");
  });
});

describe("streaming alt=sse (snapshot events -> IR chunks)", () => {
  // test #3: start/delta/stop sequence; idempotent close; first chunk role assistant.
  it("emits start/delta/stop, first chunk carries role assistant, stop only once", async () => {
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      },
    ];

    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));

    // first chunk announces role assistant
    expect(chunks[0]?.choices?.[0]?.delta?.role).toBe("assistant");
    // accumulated text across deltas
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toBe("Hello!");
    // exactly one terminal chunk with finish_reason
    const finals = chunks.filter((c) => c.choices?.[0]?.finish_reason != null);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.choices?.[0]?.finish_reason).toBe("stop");
  });

  // test #6: functionCall.args spread across snapshot events accumulate to full JSON.
  it("accumulates fragmented functionCall args across events without throwing", async () => {
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "search", args: { q: "hel" } } }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "search", args: { q: "hello world" } } }],
            },
          },
        ],
      },
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    ];

    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    // gather any tool-call argument deltas
    const argText = chunks
      .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
      .map((tc) => tc.function?.arguments ?? "")
      .join("");
    // final accumulated arguments parse to the latest snapshot
    const merged = JSON.parse(argText || "{}");
    expect(merged.q).toBe("hello world");
    const toolNames = chunks
      .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
      .map((tc) => tc.function?.name)
      .filter(Boolean);
    expect(toolNames).toContain("search");
  });

  // test #3: streaming usage subtracts cachedContentTokenCount (matches non-stream).
  it("subtracts cachedContentTokenCount from prompt_tokens and exposes cached_tokens", async () => {
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 5,
          totalTokenCount: 105,
          cachedContentTokenCount: 30,
        },
      },
    ];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const final = chunks.find((c) => c.choices?.[0]?.finish_reason != null);
    expect(final?.usage?.prompt_tokens).toBe(70);
    expect(final?.usage?.cached_tokens).toBe(30);
    expect(final?.usage?.completion_tokens).toBe(5);
  });
});

describe("transformStreamOut (IR chunks -> Gemini SSE events)", () => {
  it("emits Gemini snapshot events from IR chunks", async () => {
    const chunks: IRChunk[] = [
      { id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] },
      {
        id: "c",
        model: "m",
        choices: [{ index: 0, delta: { content: " there" }, finish_reason: "stop" }],
      },
    ];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(chunks)));
    // Gemini events are FULL snapshots: the last event carries the complete text.
    const last = events[events.length - 1];
    const text = (last?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => ("text" in p ? p.text : ""))
      .join("");
    expect(text).toBe("Hi there");
    expect(last?.candidates?.[0]?.finishReason).toBe("STOP");
  });

  // test #4: outbound streaming must surface tool calls as functionCall parts.
  it("emits a functionCall part in the cumulative snapshot from streamed tool_calls", async () => {
    const chunks: IRChunk[] = [
      {
        id: "c",
        model: "m",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: "call_0", function: { name: "get_weather" } }],
            },
          },
        ],
      },
      {
        id: "c",
        model: "m",
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } },
        ],
      },
      {
        id: "c",
        model: "m",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(chunks)));
    const last = events[events.length - 1];
    const parts = last?.candidates?.[0]?.content?.parts ?? [];
    const fcPart = parts.find((p) => "functionCall" in p) as
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | undefined;
    expect(fcPart).toBeDefined();
    expect(fcPart?.functionCall.name).toBe("get_weather");
    // complete args flushed on the finish chunk
    expect(fcPart?.functionCall.args).toEqual({ city: "SF" });
    expect(last?.candidates?.[0]?.finishReason).toBe("STOP");
  });
});

describe("endPoint routing (/v1beta/...)", () => {
  // test #7: generateContent -> non-stream; streamGenerateContent?alt=sse -> stream;
  // {model} -> IR model; declares x-goog-api-key.
  it("declares the /v1beta endpoint base and the x-goog-api-key auth header", () => {
    expect(geminiTransformer.name).toBe("gemini");
    expect(geminiTransformer.endPoint).toBe(GEMINI_ENDPOINT);
    expect(GEMINI_API_KEY_HEADER).toBe("x-goog-api-key");
  });

  it("parses generateContent path: model extracted, non-streaming", () => {
    const parsed = parseGeminiPath("/v1beta/models/gemini-1.5-pro:generateContent", "");
    expect(parsed).not.toBeNull();
    expect(parsed?.model).toBe("gemini-1.5-pro");
    expect(parsed?.stream).toBe(false);
  });

  it("parses streamGenerateContent?alt=sse path: streaming true", () => {
    const parsed = parseGeminiPath(
      "/v1beta/models/gemini-1.5-pro:streamGenerateContent",
      "alt=sse",
    );
    expect(parsed?.model).toBe("gemini-1.5-pro");
    expect(parsed?.stream).toBe(true);
  });

  it("returns null for a non-Gemini path", () => {
    expect(parseGeminiPath("/v1/chat/completions", "")).toBeNull();
  });
});
