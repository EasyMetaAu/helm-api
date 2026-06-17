import { describe, expect, it } from "vitest";
import type { IRRequest, IRResponse } from "../ir.js";
import { openaiTransformer } from "../openai.js";
import type { NativeRequest } from "../transformer.js";
import {
  collectSystemText,
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

  it("normalizes Gemini toolConfig functionCallingConfig into IR tool_choice", () => {
    expect(
      (
        geminiTransformer.transformRequestOut({
          contents: [{ role: "user", parts: [{ text: "x" }] }],
          toolConfig: { functionCallingConfig: { mode: "NONE" } },
        }) as IRRequest
      ).tool_choice,
    ).toBe("none");

    expect(
      (
        geminiTransformer.transformRequestOut({
          contents: [{ role: "user", parts: [{ text: "x" }] }],
          toolConfig: {
            functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
          },
        }) as IRRequest
      ).tool_choice,
    ).toEqual({ type: "function", function: { name: "get_weather" } });
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

  // GEM-05: generated media rides on the IR OUTPUT carriers message.images /
  // message.audio (distinct from input content parts). The response builder reuses
  // irMessageToParts, which previously read only content + tool_calls — so an
  // image-out model's result was silently dropped on the way to a Gemini client.
  it("emits generated images (message.images) as inlineData / fileData parts", () => {
    const ir: IRResponse = {
      id: "r",
      model: "gemini-2.5-flash-image",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            images: [
              { b64_json: "GENIMG", mediaType: "image/png" },
              { url: "https://files/img-1" },
            ],
          },
          finish_reason: "stop",
        },
      ],
    };
    const native = geminiTransformer.transformResponseOut(ir) as GeminiGenerateContentResponse;
    const parts = native.candidates?.[0]?.content.parts ?? [];
    expect(parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "GENIMG" } });
    expect(parts).toContainEqual({ fileData: { fileUri: "https://files/img-1" } });
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

  it("maps OpenAI tool_choice into Gemini functionCallingConfig", () => {
    const base: IRRequest = {
      model: "gemini-1.5-pro",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ],
    };

    expect(
      (
        geminiTransformer.transformRequestIn({
          ...base,
          tool_choice: "auto",
        }) as GeminiGenerateContentRequest
      ).toolConfig,
    ).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(
      (
        geminiTransformer.transformRequestIn({
          ...base,
          tool_choice: "none",
        }) as GeminiGenerateContentRequest
      ).toolConfig,
    ).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(
      (
        geminiTransformer.transformRequestIn({
          ...base,
          tool_choice: "required",
        }) as GeminiGenerateContentRequest
      ).toolConfig,
    ).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(
      (
        geminiTransformer.transformRequestIn({
          ...base,
          tool_choice: { type: "function", function: { name: "get_weather" } },
        }) as GeminiGenerateContentRequest
      ).toolConfig,
    ).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
    });
  });

  it("uses the original function name, not tool_call_id, when emitting Gemini functionResponse", () => {
    const ir: IRRequest = {
      model: "gemini-1.5-pro",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_weather_0",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_weather_0", content: "72F sunny" },
      ],
    };

    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const response = native.contents[1]?.parts[0] as {
      functionResponse: { name: string; response: unknown };
    };
    expect(response.functionResponse.name).toBe("get_weather");
  });

  it("round-trips native functionResponse.response objects through provider_raw", () => {
    const native: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "get_weather", args: { city: "SF" } } }],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "get_weather",
                response: { temp: 60, unit: "F", nested: { ok: true } },
              },
            },
          ],
        },
      ],
    };

    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const toolMsg = ir.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe(JSON.stringify({ temp: 60, unit: "F", nested: { ok: true } }));

    const back = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const response = back.contents[1]?.parts[0] as {
      functionResponse: { name: string; response: unknown };
    };
    expect(response.functionResponse).toEqual({
      name: "get_weather",
      response: { temp: 60, unit: "F", nested: { ok: true } },
    });
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

describe("system/developer fold into systemInstruction (issue #50)", () => {
  // The pure helper accumulates system + developer text IN MESSAGE ORDER,
  // joined by a blank line, skipping empty content and non-system/developer roles.
  it("collectSystemText accumulates system + developer in order", () => {
    const text = collectSystemText([
      { role: "system", content: "S1" },
      { role: "developer", content: "D1" },
      { role: "user", content: "ignored" },
      { role: "developer", content: "" }, // empty -> skipped
      { role: "system", content: "S2" },
    ]);
    expect(text).toBe("S1\n\nD1\n\nS2");
  });

  it("folds system AND developer into systemInstruction in order; contents has only the user turn", () => {
    const ir: IRRequest = {
      model: "gemini-1.5-pro",
      messages: [
        { role: "system", content: "Be precise." },
        { role: "developer", content: "Prefer metric units." },
        { role: "user", content: "weather in SF?" },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;

    const sysParts = native.systemInstruction?.parts ?? [];
    const sysText = sysParts.map((p) => (p as { text: string }).text).join("");
    expect(sysText).toBe("Be precise.\n\nPrefer metric units.");

    // developer/system must NOT leak into contents — only the user turn remains.
    expect(native.contents).toHaveLength(1);
    expect(native.contents[0]?.role).toBe("user");
    const userText = (native.contents[0]?.parts[0] as { text: string }).text;
    expect(userText).toBe("weather in SF?");
    expect(JSON.stringify(native.contents)).not.toContain("Be precise.");
    expect(JSON.stringify(native.contents)).not.toContain("Prefer metric units.");
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

  it("strips Gemini-unsupported schema keywords recursively", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string", format: "email", pattern: "@" },
        choice: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    };

    const cleaned = sanitizeSchema(schema) as Record<string, unknown>;
    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.additionalProperties).toBeUndefined();
    const props = cleaned.properties as Record<string, Record<string, unknown> | undefined>;
    expect(props.email?.format).toBeUndefined();
    expect(props.email?.pattern).toBeUndefined();
    expect(props.choice?.anyOf).toBeUndefined();
  });

  it("resolves local refs and folds combinators instead of silently weakening schema", () => {
    const schema = {
      type: "object",
      $defs: {
        City: { type: "string", description: "city name", minLength: 1 },
        Place: {
          type: "object",
          properties: { city: { $ref: "#/$defs/City" } },
          required: ["city"],
        },
      },
      properties: {
        place: { $ref: "#/$defs/Place" },
        choice: { oneOf: [{ $ref: "#/$defs/City" }, { type: "number" }] },
        merged: { allOf: [{ type: "object" }, { properties: { ok: { type: "boolean" } } }] },
      },
    };

    const cleaned = sanitizeSchema(schema) as Record<string, unknown>;
    expect(cleaned.$defs).toBeUndefined();
    const props = cleaned.properties as Record<string, Record<string, unknown> | undefined>;
    expect(props.place?.type).toBe("object");
    const placeProps = props.place?.properties as Record<string, Record<string, unknown>>;
    expect(placeProps.city).toEqual({ type: "string", description: "city name" });
    expect(props.choice).toEqual({ type: "string", description: "city name" });
    expect(props.merged?.type).toBe("object");
    expect(props.merged?.properties).toEqual({ ok: { type: "boolean" } });
  });

  it("merges allOf object shape with sibling properties and required fields", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      properties: { b: { type: "number" } },
      required: ["b"],
    };

    const cleaned = sanitizeSchema(schema) as Record<string, unknown>;
    expect(cleaned.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect(cleaned.required).toEqual(["a", "b"]);
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

  it("emits sanitized Gemini responseSchema from IR response_format json_schema", () => {
    const ir: IRRequest = {
      model: "gemini-1.5-pro",
      messages: [{ role: "user", content: "return json" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: {
            type: "object",
            properties: { when: { type: "string", format: "date-time" } },
            required: ["when"],
          },
        },
      },
    };

    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    expect(native.generationConfig?.responseMimeType).toBe("application/json");
    const schema = native.generationConfig?.responseSchema as {
      properties: Record<string, Record<string, unknown> | undefined>;
    };
    expect(schema.properties.when?.format).toBeUndefined();
    expect(schema.properties.when?.description).toContain("format: date-time");
  });

  it("keeps remote image outbound as explicit text non-goal instead of invalid inlineData", () => {
    const ir: IRRequest = {
      model: "gemini-1.5-pro",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", url: "https://example.com/cat.png", mediaType: "image/png" },
          ],
        },
      ],
    };

    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    expect(JSON.stringify(native)).not.toContain("inlineData");
    expect(JSON.stringify(native)).toContain("remote image unsupported");
    expect(JSON.stringify(native)).toContain("https://example.com/cat.png");
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

  // Regression (Codex P2): ?alt=sse frames are DELTAS, not snapshots. A delta that
  // happens to be a prefix-extension of the previous one must NOT be truncated by
  // snapshot diffing — "a" then "ab" must concatenate to "aab", not "ab".
  it("treats prefix-overlapping frames as deltas, not snapshots (no truncation)", async () => {
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "a" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "ab" }] }, finishReason: "STOP" }],
      },
    ];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toBe("aab");
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

  it("keeps same-name parallel function calls in separate streaming slots", async () => {
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "search", args: { q: "alpha" } } },
                { functionCall: { name: "search", args: { q: "beta" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ];

    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const toolCalls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((tc) => tc.index)).toEqual([0, 1]);
    expect(toolCalls.map((tc) => tc.id)).toEqual(["call_search_0", "call_search_1"]);
    expect(toolCalls.map((tc) => JSON.parse(tc.function?.arguments ?? "{}"))).toEqual([
      { q: "alpha" },
      { q: "beta" },
    ]);
  });

  it("keeps same-name parallel function calls split across streaming frames", async () => {
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "search", args: { q: "alpha" } } }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "search", args: { q: "beta" } } }],
            },
            finishReason: "STOP",
          },
        ],
      },
    ];

    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const toolCalls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolCalls).toHaveLength(2);
    expect(new Set(toolCalls.map((tc) => tc.id)).size).toBe(2);
    expect(toolCalls.map((tc) => JSON.parse(tc.function?.arguments ?? "{}"))).toEqual([
      { q: "alpha" },
      { q: "beta" },
    ]);
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
  // Concatenate text parts across ALL events — the real Gemini wire contract: clients
  // accumulate `chunk.text`, so events must carry incremental deltas, not snapshots.
  const concatText = (events: GeminiSSEEvent[]): string =>
    events
      .flatMap((e) => e.candidates?.[0]?.content?.parts ?? [])
      .map((p) => ("text" in p ? (p.text ?? "") : ""))
      .join("");

  it("emits INCREMENTAL text deltas, not cumulative snapshots (no duplication)", async () => {
    const chunks: IRChunk[] = [
      { id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] },
      {
        id: "c",
        model: "m",
        choices: [{ index: 0, delta: { content: " there" }, finish_reason: "stop" }],
      },
    ];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(chunks)));
    // Real Gemini emits deltas a client concatenates → the running join is the full
    // text with NO duplication. (A cumulative-snapshot impl would yield "HiHi there".)
    expect(concatText(events)).toBe("Hi there");
    // No single event may carry the whole accumulated text — that would double-count
    // on a client that appends each chunk.
    for (const ev of events) {
      const t = (ev.candidates?.[0]?.content?.parts ?? [])
        .map((p) => ("text" in p ? (p.text ?? "") : ""))
        .join("");
      expect(t).not.toBe("Hi there");
    }
    // finishReason rides on exactly one (the terminal) event.
    const withFinish = events.filter((e) => e.candidates?.[0]?.finishReason !== undefined);
    expect(withFinish).toHaveLength(1);
    expect(withFinish[0]?.candidates?.[0]?.finishReason).toBe("STOP");
  });

  it("reconstructs full Gemini promptTokenCount from streaming cache usage details", async () => {
    const chunks: IRChunk[] = [
      {
        id: "c",
        model: "m",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }],
      },
      {
        id: "c",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 30, cache_creation_tokens: 10 },
        },
      },
    ];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(chunks)));
    const terminal = events.find((e) => e.usageMetadata !== undefined);
    expect(terminal?.usageMetadata?.promptTokenCount).toBe(140);
    expect(terminal?.usageMetadata?.cachedContentTokenCount).toBe(30);
    expect(terminal?.usageMetadata?.totalTokenCount).toBe(160);
  });

  // test #4: outbound streaming must surface tool calls as a complete functionCall part
  // (one delta event), flushed once args are complete — never a half-parsed JSON.
  it("emits a single complete functionCall part from streamed tool_calls", async () => {
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
    // The functionCall part appears in EXACTLY ONE event (a delta), never re-emitted
    // across snapshots, and only once its args are a complete parseable JSON.
    const fcParts = events
      .flatMap((e) => e.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => "functionCall" in p) as Array<{
      functionCall: { name: string; args: Record<string, unknown> };
    }>;
    expect(fcParts).toHaveLength(1);
    expect(fcParts[0]?.functionCall.name).toBe("get_weather");
    expect(fcParts[0]?.functionCall.args).toEqual({ city: "SF" });
    // finishReason rides on exactly one (the terminal) event.
    const withFinish = events.filter((e) => e.candidates?.[0]?.finishReason !== undefined);
    expect(withFinish).toHaveLength(1);
    expect(withFinish[0]?.candidates?.[0]?.finishReason).toBe("STOP");
  });
});

describe("generationConfig param round-trip (litellm parity)", () => {
  it("maps IR sampling/control params -> Gemini generationConfig (IR -> Gemini)", () => {
    const ir: IRRequest = {
      model: "gemini-1.5-pro",
      messages: [{ role: "user", content: "hi" }],
      top_p: 0.9,
      top_k: 40,
      frequency_penalty: 0.2,
      presence_penalty: 0.3,
      seed: 7,
      stop: ["STOP", "END"],
      n: 2,
      logprobs: true,
      top_logprobs: 3,
      modalities: ["text", "image"],
      temperature: 0.5,
      max_tokens: 128,
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const gc = native.generationConfig;
    expect(gc?.topP).toBe(0.9);
    expect(gc?.topK).toBe(40);
    expect(gc?.frequencyPenalty).toBe(0.2);
    expect(gc?.presencePenalty).toBe(0.3);
    expect(gc?.seed).toBe(7);
    expect(gc?.stopSequences).toEqual(["STOP", "END"]);
    expect(gc?.candidateCount).toBe(2);
    expect(gc?.responseLogprobs).toBe(true);
    expect(gc?.logprobs).toBe(3);
    expect(gc?.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(gc?.temperature).toBe(0.5);
    expect(gc?.maxOutputTokens).toBe(128);
  });

  it("maps a single-string stop into stopSequences as a one-element array", () => {
    const native = geminiTransformer.transformRequestIn({
      model: "gemini-1.5-pro",
      messages: [{ role: "user", content: "hi" }],
      stop: "DONE",
    }) as GeminiGenerateContentRequest;
    expect(native.generationConfig?.stopSequences).toEqual(["DONE"]);
  });

  it("round-trips Gemini cachedContent via IR.cached_content", () => {
    const nativeIn: GeminiGenerateContentRequest = {
      cachedContent: "cachedContents/context-123",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    };
    const ir = geminiTransformer.transformRequestOut(nativeIn) as IRRequest;
    expect(ir.cached_content).toBe("cachedContents/context-123");

    const nativeOut = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    expect(nativeOut.cachedContent).toBe("cachedContents/context-123");
  });

  it("round-trips Gemini safetySettings through provider_raw", () => {
    const safetySettings = [
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ];
    const nativeIn: GeminiGenerateContentRequest = {
      safetySettings,
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    };

    const ir = geminiTransformer.transformRequestOut(nativeIn) as IRRequest;
    expect(ir.provider_raw?.safety_settings).toEqual(safetySettings);

    const nativeOut = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    expect(nativeOut.safetySettings).toEqual(safetySettings);
  });

  it("maps reasoning_effort -> thinkingConfig (low/medium/high), minimal allowed", () => {
    const mk = (effort: "minimal" | "low" | "medium" | "high"): GeminiGenerateContentRequest =>
      geminiTransformer.transformRequestIn({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: effort,
      }) as GeminiGenerateContentRequest;

    expect(mk("low").generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
    const lowBudget = mk("low").generationConfig?.thinkingConfig?.thinkingBudget;
    const medBudget = mk("medium").generationConfig?.thinkingConfig?.thinkingBudget;
    const highBudget = mk("high").generationConfig?.thinkingConfig?.thinkingBudget;
    expect(typeof lowBudget).toBe("number");
    // budgets increase with effort.
    expect((medBudget ?? 0) > (lowBudget ?? 0)).toBe(true);
    expect((highBudget ?? 0) > (medBudget ?? 0)).toBe(true);
    // minimal is allowed (some thinking config emitted, not undefined).
    expect(mk("minimal").generationConfig?.thinkingConfig).toBeDefined();
  });

  it("maps Gemini generationConfig -> IR params (Gemini -> IR)", () => {
    const native: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        topP: 0.8,
        topK: 20,
        frequencyPenalty: 0.1,
        presencePenalty: 0.15,
        seed: 11,
        stopSequences: ["A", "B"],
        candidateCount: 3,
        responseLogprobs: true,
        logprobs: 2,
        responseModalities: ["TEXT", "IMAGE"],
      },
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.top_p).toBe(0.8);
    expect(ir.top_k).toBe(20);
    expect(ir.frequency_penalty).toBe(0.1);
    expect(ir.presence_penalty).toBe(0.15);
    expect(ir.seed).toBe(11);
    expect(ir.stop).toEqual(["A", "B"]);
    expect(ir.n).toBe(3);
    expect(ir.logprobs).toBe(true);
    expect(ir.top_logprobs).toBe(2);
    expect(ir.modalities).toEqual(["text", "image"]);
  });
});

describe("usage detail (thoughtsTokenCount + per-modality details)", () => {
  it("maps thoughtsTokenCount -> reasoning_tokens and modality details (Gemini -> IR)", () => {
    const native: GeminiGenerateContentResponse = {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 135,
        cachedContentTokenCount: 10,
        thoughtsTokenCount: 15,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 80 },
          { modality: "IMAGE", tokenCount: 20 },
        ],
        candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 20 }],
      },
    };
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.usage?.prompt_tokens).toBe(90); // 100 - 10 cached
    expect(ir.usage?.completion_tokens).toBe(20);
    expect(ir.usage?.cached_tokens).toBe(10);
    expect(ir.usage?.reasoning_tokens).toBe(15);
    expect(ir.usage?.prompt_tokens_details?.text_tokens).toBe(80);
    expect(ir.usage?.prompt_tokens_details?.image_tokens).toBe(20);
    expect(ir.usage?.completion_tokens_details?.text_tokens).toBe(20);
  });

  it("emits totalTokenCount/cachedContentTokenCount/thoughtsTokenCount (IR -> Gemini)", () => {
    const ir: IRResponse = {
      id: "r",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 10,
        cached_tokens: 5,
        cache_creation_tokens: 2,
        reasoning_tokens: 4,
      },
    };
    const native = geminiTransformer.transformResponseOut(ir) as GeminiGenerateContentResponse;
    const um = native.usageMetadata;
    // prompt = prompt_tokens + cached + cache creation; total = prompt + completion.
    expect(um?.promptTokenCount).toBe(37);
    expect(um?.candidatesTokenCount).toBe(10);
    expect(um?.totalTokenCount).toBe(47);
    expect(um?.cachedContentTokenCount).toBe(5);
    expect(um?.thoughtsTokenCount).toBe(4);
  });
});

describe("grounding/citation -> annotations + logprobs", () => {
  it("folds groundingMetadata chunks+supports into IRMessage.annotations (url_citation)", () => {
    const native: GeminiGenerateContentResponse = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Paris is the capital." }] },
          finishReason: "STOP",
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://example.com/a", title: "Source A" } },
              { web: { uri: "https://example.com/b", title: "Source B" } },
            ],
            groundingSupports: [
              { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] },
            ],
          },
        },
      ],
    };
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    const annotations = ir.choices[0]?.message.annotations ?? [];
    expect(annotations.length).toBeGreaterThanOrEqual(2);
    const first = annotations.find((a) => a.url === "https://example.com/a");
    expect(first?.type).toBe("url_citation");
    expect(first?.title).toBe("Source A");
    // a support segment carries start/end indices.
    const withSeg = annotations.find((a) => a.start_index === 0 && a.end_index === 5);
    expect(withSeg).toBeDefined();
  });

  it("maps logprobsResult -> IRChoice.logprobs and safetyRatings -> provider_raw", () => {
    const native: GeminiGenerateContentResponse = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "hi" }] },
          finishReason: "STOP",
          logprobsResult: { topCandidates: [], chosenCandidates: [] },
          safetyRatings: [{ category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" }],
        },
      ],
    };
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.logprobs).toBeDefined();
    expect(ir.provider_raw?.safety_ratings).toBeDefined();
  });
});

describe("promptFeedback block (content_filter)", () => {
  it("sets finish_reason content_filter and stashes promptFeedback in provider_raw", () => {
    const native: GeminiGenerateContentResponse = {
      promptFeedback: {
        blockReason: "SAFETY",
        safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH" }],
      },
    };
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.finish_reason).toBe("content_filter");
    const pf = ir.provider_raw?.prompt_feedback as { blockReason?: string } | undefined;
    expect(pf?.blockReason).toBe("SAFETY");
  });
});

describe("finishReason additions (litellm parity)", () => {
  const cases: Array<[string, string]> = [
    ["LANGUAGE", "content_filter"],
    ["IMAGE_SAFETY", "content_filter"],
    ["IMAGE_PROHIBITED_CONTENT", "content_filter"],
    ["TOO_MANY_TOOL_CALLS", "stop"],
    ["MALFORMED_RESPONSE", "stop"],
    ["FINISH_REASON_UNSPECIFIED", "stop"],
  ];
  for (const [gemini, ir] of cases) {
    it(`maps ${gemini} -> ${ir} and keeps raw`, () => {
      const native: GeminiGenerateContentResponse = {
        candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: gemini }],
      };
      const out = geminiTransformer.transformResponseIn(native) as IRResponse;
      expect(out.choices[0]?.finish_reason).toBe(ir);
      expect(out.provider_raw?.stop_reason).toBe(gemini);
    });
  }
});

describe("generated media parts (inlineData image/audio -> IRMessage)", () => {
  it("routes an image/* inlineData part to IRMessage.images", () => {
    const native: GeminiGenerateContentResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ inlineData: { mimeType: "image/png", data: "IMGDATA" } }],
          },
          finishReason: "STOP",
        },
      ],
    };
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    const imgs = ir.choices[0]?.message.images ?? [];
    expect(imgs[0]?.b64_json).toBe("IMGDATA");
    expect(imgs[0]?.mediaType).toBe("image/png");
  });

  it("routes an audio/* inlineData part to IRMessage.audio", () => {
    const native: GeminiGenerateContentResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ inlineData: { mimeType: "audio/wav", data: "AUDIODATA" } }],
          },
          finishReason: "STOP",
        },
      ],
    };
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.message.audio?.data).toBe("AUDIODATA");
  });
});

describe("multimodal tool results -> Gemini (MULTI-01)", () => {
  it("emits non-text tool_result parts as sibling media instead of dropping them", () => {
    const ir: IRRequest = {
      model: "gemini-2.5-pro",
      messages: [
        { role: "user", content: "screenshot?" },
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "screenshot",
          content: [
            { type: "text", text: "see image" },
            { type: "image", url: "data:image/png;base64,SHOT" },
          ],
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const toolTurn = native.contents.find((ct) =>
      ct.parts.some((p) => p.functionResponse !== undefined),
    );
    const parts = toolTurn?.parts ?? [];
    // text still rides on functionResponse.content …
    expect(
      parts.some((p) => JSON.stringify(p.functionResponse?.response ?? {}).includes("see image")),
    ).toBe(true);
    // … and the image survives as a sibling inlineData part (not silently dropped).
    expect(parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "SHOT" } });
  });
});

describe("streaming reasoning (thought parts)", () => {
  it("emits Gemini thought parts as delta.reasoning_content (Gemini -> IR)", async () => {
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          { content: { role: "model", parts: [{ text: "thinking...", thought: true }] } },
        ],
      },
      { candidates: [{ content: { role: "model", parts: [{ text: "Answer" }] } }] },
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    ];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content ?? "").join("");
    expect(reasoning).toBe("thinking...");
    // the thought text must NOT also leak into the visible content stream.
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(content).toBe("Answer");
  });

  it("emits IR delta.reasoning_content as a Gemini thought part (IR -> Gemini)", async () => {
    const chunks: IRChunk[] = [
      {
        id: "c",
        model: "m",
        choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "ponder" } }],
      },
      {
        id: "c",
        model: "m",
        choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }],
      },
    ];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(chunks)));
    const thoughtParts = events
      .flatMap((e) => e.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => (p as { thought?: boolean }).thought === true) as Array<{ text?: string }>;
    expect(thoughtParts.map((p) => p.text).join("")).toBe("ponder");
  });

  it("accumulates groundingMetadata across stream and emits annotations on terminal chunk", async () => {
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "Paris" }] } }] },
      {
        candidates: [
          {
            content: { role: "model", parts: [] },
            finishReason: "STOP",
            groundingMetadata: {
              groundingChunks: [{ web: { uri: "https://example.com/x", title: "X" } }],
            },
          },
        ],
      },
    ];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const annotated = chunks.find((c) => (c.choices?.[0]?.delta?.annotations ?? []).length > 0);
    expect(annotated?.choices?.[0]?.delta?.annotations?.[0]?.url).toBe("https://example.com/x");
  });

  it("surfaces a top-level error SSE frame by throwing", async () => {
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] },
      { error: { code: 429, message: "rate limited", status: "RESOURCE_EXHAUSTED" } },
    ];
    await expect(collect(geminiTransformer.transformStreamIn(fromArray(events)))).rejects.toThrow(
      /rate limited/,
    );
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

  it("parses LiteLLM-compatible /models paths and path-style model names", () => {
    const parsed = parseGeminiPath("/models/google/gemini-2.5-pro:generateContent", "");
    expect(parsed).toEqual({
      model: "google/gemini-2.5-pro",
      operation: "generateContent",
      stream: false,
    });
  });

  it("parses streamGenerateContent?alt=sse path: streaming true", () => {
    const parsed = parseGeminiPath(
      "/v1beta/models/gemini-1.5-pro:streamGenerateContent",
      "alt=sse",
    );
    expect(parsed?.model).toBe("gemini-1.5-pro");
    expect(parsed?.stream).toBe(true);
  });

  it("treats streamGenerateContent as streaming even without alt=sse", () => {
    const parsed = parseGeminiPath("/v1beta/models/gemini-1.5-pro:streamGenerateContent", "");
    expect(parsed).toEqual({
      model: "gemini-1.5-pro",
      operation: "streamGenerateContent",
      stream: true,
    });
  });

  it("returns null for a non-Gemini path", () => {
    expect(parseGeminiPath("/v1/chat/completions", "")).toBeNull();
  });
});

describe("Gemini multimodal input (P7) — inlineData/fileData + videoMetadata", () => {
  // Inbound: inlineData routed by MIME to the right IR part (audio/video/document/image).
  it("routes inlineData by MIME: audio/* -> IR audio part", () => {
    const native = {
      contents: [
        { role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: "QUJD" } }] },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({ type: "audio", data: "QUJD", format: "wav" });
  });

  it("routes inlineData by MIME: application/pdf -> IR document part", () => {
    const native = {
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "application/pdf", data: "JVBE" } }],
        },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({
      type: "document",
      data: "JVBE",
      mediaType: "application/pdf",
    });
  });

  it("routes inlineData image/* -> IR image part (unchanged)", () => {
    const native = {
      contents: [
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({ type: "image", url: "data:image/png;base64,AAAA" });
  });

  it("maps a video fileData + videoMetadata into an IR video part", () => {
    const native = {
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: { mimeType: "video/mp4", fileUri: "gs://bucket/clip.mp4" },
              videoMetadata: { fps: 2, startOffset: "1.5s", endOffset: "5s" },
            },
          ],
        },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({
      type: "video",
      url: "gs://bucket/clip.mp4",
      mediaType: "video/mp4",
      fps: 2,
      startOffset: "1.5s",
      endOffset: "5s",
    });
  });

  // Outbound: IR audio/video/document parts -> Gemini inlineData/fileData + videoMetadata.
  it("renders an IR audio part as Gemini inlineData", () => {
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: [{ type: "audio", data: "QUJD", format: "wav" }] }],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const part = native.contents[0]?.parts?.[0] as {
      inlineData?: { mimeType?: string; data?: string };
    };
    expect(part.inlineData?.mimeType).toBe("audio/wav");
    expect(part.inlineData?.data).toBe("QUJD");
  });

  it("renders an IR document part (base64) as Gemini inlineData", () => {
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "document", data: "JVBE", mediaType: "application/pdf" }],
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const part = native.contents[0]?.parts?.[0] as { inlineData?: { mimeType?: string } };
    expect(part.inlineData?.mimeType).toBe("application/pdf");
  });

  it("renders an IR video part (remote uri + metadata) as Gemini fileData + videoMetadata", () => {
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "video",
              url: "gs://bucket/clip.mp4",
              mediaType: "video/mp4",
              fps: 2,
              startOffset: "1.5s",
              endOffset: "5s",
            },
          ],
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const part = native.contents[0]?.parts?.[0] as {
      fileData?: { mimeType?: string; fileUri?: string };
      videoMetadata?: { fps?: number; startOffset?: string; endOffset?: string };
    };
    expect(part.fileData?.fileUri).toBe("gs://bucket/clip.mp4");
    expect(part.fileData?.mimeType).toBe("video/mp4");
    expect(part.videoMetadata?.fps).toBe(2);
    expect(part.videoMetadata?.startOffset).toBe("1.5s");
  });
});

describe("Gemini Tier E fidelity (orders 26-31)", () => {
  // order 26: a functionCall with finishReason STOP must surface as tool_calls (Gemini
  // doesn't emit a TOOL_CALLS reason; it returns STOP alongside the call).
  it("remaps finishReason STOP -> tool_calls when a functionCall is present (non-stream)", () => {
    const native = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "get_weather", args: { city: "SF" } } }],
          },
          finishReason: "STOP",
        },
      ],
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("honors an explicit TOOL_CALLS finishReason enum", () => {
    const native = {
      candidates: [
        { content: { role: "model", parts: [{ text: "x" }] }, finishReason: "TOOL_CALLS" },
      ],
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("remaps the streaming terminal finish to tool_calls when functionCalls were seen (order 26)", async () => {
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "f", args: { a: 1 } } }] },
          },
        ],
      },
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const terminal = chunks.at(-1) as IRChunk;
    expect(terminal.choices?.[0]?.finish_reason).toBe("tool_calls");
  });

  // order 27: a streaming promptFeedback.blockReason means the prompt was rejected ->
  // content_filter terminal finish (the non-stream path already does this).
  it("maps streaming promptFeedback.blockReason to content_filter (order 27)", async () => {
    const events = [{ promptFeedback: { blockReason: "SAFETY" } }] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const terminal = chunks.at(-1) as IRChunk;
    expect(terminal.choices?.[0]?.finish_reason).toBe("content_filter");
  });

  // order 28: cacheTokensDetails (per-modality cached split) must reach the IR cached
  // count even when the aggregate cachedContentTokenCount is absent.
  it("parses cacheTokensDetails into the IR cached token count (order 28)", () => {
    const native = {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 5,
        cacheTokensDetails: [{ modality: "TEXT", tokenCount: 30 }],
      },
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.usage?.cached_tokens).toBe(30);
    expect(ir.usage?.prompt_tokens_details?.cached_tokens).toBe(30);
    expect(ir.usage?.prompt_tokens).toBe(70);
  });

  // order 29: a multimodal IR message with NO non-empty text part must gain a defensive
  // text part on the outbound Gemini request (Gemini rejects a parts array with no text).
  it("appends a defensive text part for an image-only message (order 29)", () => {
    const native = geminiTransformer.transformRequestIn({
      model: "gemini-1.5-pro",
      messages: [{ role: "user", content: [{ type: "image", url: "https://x/y.png" }] }],
    }) as GeminiGenerateContentRequest;
    const parts = native.contents?.[0]?.parts ?? [];
    const hasText = parts.some((p) => typeof p.text === "string" && p.text.length > 0);
    expect(hasText).toBe(true);
  });

  // order 30: the terminal stream chunk must carry reasoning_tokens (thoughtsTokenCount).
  // Gemini ?alt=sse reports usage on the final frame; OpenAI streaming convention is a
  // SINGLE usage frame, so we surface it on the terminal chunk (not mid-stream).
  it("exposes reasoning_tokens on the terminal stream chunk usage (order 30)", async () => {
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 8,
        },
      },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const terminal = chunks.at(-1) as IRChunk;
    expect(terminal.usage?.reasoning_tokens).toBe(8);
    // Exactly one chunk carries usage (no mid-stream usage frames).
    expect(chunks.filter((c) => c.usage !== undefined)).toHaveLength(1);
  });

  // order 31: an unknown future modality's token count must not be silently dropped.
  it("preserves an unknown modality's token count in prompt_tokens_details (order 31)", () => {
    const native = {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        promptTokensDetails: [{ modality: "HOLOGRAM", tokenCount: 7 }],
      },
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    const details = ir.usage?.prompt_tokens_details as Record<string, number> | undefined;
    const total = Object.values(details ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(7);
  });
});

// —— inbound media routing: the fileData / inlineData branches not yet hit. ——
describe("Gemini inbound media routing (inlineData + fileData by MIME)", () => {
  it("routes a remote audio fileData uri to an IR document part (lossless)", () => {
    const native = {
      contents: [
        {
          role: "user",
          parts: [{ fileData: { mimeType: "audio/mpeg", fileUri: "gs://b/song.mp3" } }],
        },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({
      type: "document",
      url: "gs://b/song.mp3",
      mediaType: "audio/mpeg",
    });
  });

  it("routes a remote image fileData uri to an IR image part", () => {
    const native = {
      contents: [
        {
          role: "user",
          parts: [{ fileData: { mimeType: "image/jpeg", fileUri: "gs://b/pic.jpg" } }],
        },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({
      type: "image",
      url: "gs://b/pic.jpg",
      mediaType: "image/jpeg",
    });
  });

  it("routes a generic fileData (no MIME) to a document part with just the uri", () => {
    const native = {
      contents: [{ role: "user", parts: [{ fileData: { fileUri: "gs://b/file.bin" } }] }],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toEqual({ type: "document", url: "gs://b/file.bin" });
  });

  it("routes a fileData with only videoMetadata (no MIME) to a video part", () => {
    // mime === "" but videoMetadata present → the video branch (line 236) fires.
    const native = {
      contents: [
        {
          role: "user",
          parts: [{ fileData: { fileUri: "gs://b/clip" }, videoMetadata: { fps: 4 } }],
        },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({ type: "video", url: "gs://b/clip", fps: 4 });
  });

  it("degrades an unknown part shape to a JSON text placeholder (fail-open)", () => {
    // A part with none of text/inlineData/fileData/functionCall/functionResponse → the
    // catch-all JSON.stringify placeholder (lines 420-421).
    const native = {
      contents: [{ role: "user", parts: [{ executableCode: { code: "print(1)" } }] }],
    } as unknown as GeminiGenerateContentRequest;
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({ type: "text" });
    expect((parts[0] as { text: string }).text).toContain("executableCode");
  });
});

// —— inbound request: tools + response_format branches in transformRequestOut. ——
describe("Gemini transformRequestOut — tools + response_format", () => {
  it("maps functionDeclarations into IR tools (with description + parameters)", () => {
    const native: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              description: "look something up",
              parameters: { type: "object", properties: { q: { type: "string" } } },
            },
          ],
        },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "look something up",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ]);
  });

  it("maps Google GenAI parametersJsonSchema into IR tool parameters", () => {
    const native: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              parametersJsonSchema: { type: "object", properties: { q: { type: "string" } } },
            },
          ],
        },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.tools?.[0]).toEqual({
      type: "function",
      function: {
        name: "lookup",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    });
  });

  it("maps responseMimeType application/json + responseSchema to a json_schema response_format", () => {
    const native: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: { type: "object", properties: { n: { type: "number" } } },
      },
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    // The IR is OpenAI-shaped, so json_schema MUST carry { name, schema } (issue
    // #217): Gemini's schema is anonymous, so a synthetic `name` is supplied and the
    // schema is nested under `.schema` — the shape the OpenAI response_format
    // contract (and every OpenAI-compatible upstream) requires.
    expect(ir.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "response",
        schema: { type: "object", properties: { n: { type: "number" } } },
      },
    });
  });

  it.each([
    "responseJsonSchema",
    "response_json_schema",
  ] as const)("maps responseMimeType application/json + %s to a json_schema response_format", (field) => {
    const native = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        [field]: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    } as unknown as GeminiGenerateContentRequest;
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "response",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
  });

  it("cross-protocol regression (issue #217): a Gemini responseJsonSchema request yields an IR response_format that PASSES the OpenAI response_format contract", () => {
    // Reproduces the la.atmy.work outage: a Gemini-CLI structured-output request
    // routed to the gemini-flash lane's OpenAI-compatible fallback. The IR is
    // OpenAI-shaped and fail-closed validated by the OpenAI transformer before the
    // upstream call; pre-fix the json_schema lacked name/schema, so EVERY candidate
    // threw `response_format.json_schema.name expected string` and the breaker
    // cascaded to all_providers_failed.
    const native = {
      contents: [{ role: "user", parts: [{ text: "score this" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "OBJECT",
          properties: {
            complexity_score: { type: "INTEGER" },
            complexity_reasoning: { type: "STRING" },
          },
          required: ["complexity_score", "complexity_reasoning"],
        },
      },
    } as unknown as GeminiGenerateContentRequest;
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(() =>
      openaiTransformer.transformRequestOut({
        model: "gpt-x",
        messages: [{ role: "user", content: "score this" }],
        response_format: ir.response_format,
      } as unknown as NativeRequest),
    ).not.toThrow();
  });

  it("maps responseMimeType application/json with NO schema to a bare json_object", () => {
    const native: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { responseMimeType: "application/json" },
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.response_format).toEqual({ type: "json_object" });
  });

  it("emits Google GenAI parametersJsonSchema and responseJsonSchema when requested", () => {
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
      provider_raw: { gemini_schema_style: "google_genai" },
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const decl = native.tools?.[0]?.functionDeclarations?.[0] as {
      parameters?: unknown;
      parametersJsonSchema?: unknown;
    };
    expect(decl.parameters).toBeUndefined();
    expect(decl.parametersJsonSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(native.generationConfig?.responseSchema).toBeUndefined();
    expect(native.generationConfig?.responseJsonSchema).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });

  it("preserves Google GenAI advanced optional params in provider_raw and native replay", () => {
    const native = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      routing_config: { manual: true },
      model_selection_config: { featureSelectionPreference: "PRIORITIZE_QUALITY" },
      labels: { env: "test" },
      media_resolution: "MEDIA_RESOLUTION_MEDIUM",
      speech_config: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      audio_timestamp: true,
      automatic_function_calling: { disable: true },
      image_config: { aspectRatio: "1:1" },
    } as unknown as GeminiGenerateContentRequest;

    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.provider_raw?.google_genai).toEqual({
      routing_config: { manual: true },
      model_selection_config: { featureSelectionPreference: "PRIORITIZE_QUALITY" },
      labels: { env: "test" },
      media_resolution: "MEDIA_RESOLUTION_MEDIUM",
      speech_config: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      audio_timestamp: true,
      automatic_function_calling: { disable: true },
      image_config: { aspectRatio: "1:1" },
    });

    const replay = geminiTransformer.transformRequestIn(ir) as Record<string, unknown>;
    expect(replay).toMatchObject({
      routing_config: { manual: true },
      model_selection_config: { featureSelectionPreference: "PRIORITIZE_QUALITY" },
      labels: { env: "test" },
      media_resolution: "MEDIA_RESOLUTION_MEDIUM",
      speech_config: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      audio_timestamp: true,
      automatic_function_calling: { disable: true },
      image_config: { aspectRatio: "1:1" },
    });
  });
});

// —— outbound media + reasoning: irContentPartToGeminiParts / irMessageToParts. ——
describe("Gemini outbound part rendering (irMessageToParts)", () => {
  it("renders an IR document part with a remote uri as Gemini fileData", () => {
    // document with `url` (no data) → fileData branch (lines 569-578).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "document", url: "gs://b/doc.pdf", mediaType: "application/pdf" }],
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const part = native.contents[0]?.parts?.find((p) => "fileData" in p) as {
      fileData?: { fileUri?: string; mimeType?: string };
    };
    expect(part?.fileData?.fileUri).toBe("gs://b/doc.pdf");
    expect(part?.fileData?.mimeType).toBe("application/pdf");
  });

  it("renders an IR video part with inline base64 data as Gemini inlineData", () => {
    // video with `data` (no url) → inlineData branch (lines 601-608) + videoMetadata.
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "video", data: "VklE", mediaType: "video/webm", fps: 3 }],
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const part = native.contents[0]?.parts?.find((p) => "inlineData" in p) as {
      inlineData?: { mimeType?: string; data?: string };
      videoMetadata?: { fps?: number };
    };
    expect(part?.inlineData?.mimeType).toBe("video/webm");
    expect(part?.inlineData?.data).toBe("VklE");
    expect(part?.videoMetadata?.fps).toBe(3);
  });

  it("emits IR thinking content parts as Gemini thought parts (P6)", () => {
    // A thinking content part → Gemini { text, thought:true, thoughtSignature } (625-630).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "let me think", signature: "sig123" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const parts = native.contents[0]?.parts ?? [];
    const thought = parts.find((p) => (p as { thought?: boolean }).thought === true) as {
      text?: string;
      thoughtSignature?: string;
    };
    expect(thought?.text).toBe("let me think");
    expect(thought?.thoughtSignature).toBe("sig123");
  });

  it("emits IR audio output (message.audio) as a Gemini audio/wav inlineData part", () => {
    // message.audio output carrier → inlineData audio/wav (lines 657-658).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "assistant", content: null, audio: { data: "QVVE" } }],
    } as unknown as IRRequest;
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const part = native.contents[0]?.parts?.find((p) => "inlineData" in p) as {
      inlineData?: { mimeType?: string; data?: string };
    };
    expect(part?.inlineData?.mimeType).toBe("audio/wav");
    expect(part?.inlineData?.data).toBe("QVVE");
  });
});

// —— tool_choice ANY → functionCallingConfig and the reverse single/multi-name. ——
describe("Gemini tool_choice / functionCallingConfig ANY mode", () => {
  it("maps a single-name ANY functionCallingConfig to a specific-function tool_choice", () => {
    const native = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolConfig: {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["only_this"] },
      },
    } as unknown as GeminiGenerateContentRequest;
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.tool_choice).toEqual({ type: "function", function: { name: "only_this" } });
  });

  it("maps a multi-name ANY functionCallingConfig to 'required'", () => {
    const native = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["a", "b"] } },
    } as unknown as GeminiGenerateContentRequest;
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.tool_choice).toBe("required");
  });

  it("maps an ANY config with no allowedFunctionNames to 'required'", () => {
    const native = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    } as unknown as GeminiGenerateContentRequest;
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.tool_choice).toBe("required");
  });

  it("ignores a toolConfig with an unknown mode (no tool_choice)", () => {
    const native = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolConfig: { functionCallingConfig: { mode: "WHATEVER" } },
    } as unknown as GeminiGenerateContentRequest;
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.tool_choice).toBeUndefined();
  });
});

// —— inbound response edge cases: thought parts, non-image inlineData, no candidate. ——
describe("Gemini transformResponseIn — candidate part edge cases", () => {
  it("maps a thought response part to an IR thinking part + flat reasoning_content", () => {
    // part.thought===true → thinking part (lines 903-906); liftReasoningToFlat mirrors it.
    const native = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "deliberating", thought: true, thoughtSignature: "sg" },
              { text: "final answer" },
            ],
          },
          finishReason: "STOP",
        },
      ],
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    const msg = ir.choices[0]?.message;
    const parts = msg?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts.find((p) => p.type === "thinking")).toMatchObject({
      type: "thinking",
      text: "deliberating",
      signature: "sg",
    });
    expect(msg?.reasoning_content).toBe("deliberating");
  });

  it("degrades a non-image/non-audio inlineData response part to an image data-url part", () => {
    // inlineData mime is neither image/* nor audio/* → fallback inlineDataToImagePart
    // pushes a data-url image content part (lines 918-919).
    const native = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ inlineData: { mimeType: "application/pdf", data: "JVBE" } }],
          },
          finishReason: "STOP",
        },
      ],
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    const parts = ir.choices[0]?.message?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({
      type: "image",
      url: "data:application/pdf;base64,JVBE",
    });
  });

  it("returns an empty assistant message when the response has no candidate", () => {
    // candidates absent → the `{ role:'assistant', content:'' }` default (line 959).
    const native = {
      usageMetadata: { promptTokenCount: 3 },
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.message).toMatchObject({ role: "assistant", content: "" });
    expect(ir.usage?.prompt_tokens).toBe(3);
  });

  it("surfaces a promptFeedback.blockReason as content_filter and keeps it as raw stop_reason", () => {
    // No candidate + promptFeedback.blockReason → content_filter + provider_raw.stop_reason
    // from the block (lines 1001-1004, 1031-1033).
    const native = {
      promptFeedback: { blockReason: "SAFETY" },
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.finish_reason).toBe("content_filter");
    expect((ir.provider_raw as { stop_reason?: string }).stop_reason).toBe("SAFETY");
  });
});

// —— transformResponseOut: finishReason omitted when the IR carries none. ——
describe("Gemini transformResponseOut — finishReason presence", () => {
  it("omits finishReason when the IR choice has a null finish_reason", () => {
    const ir: IRResponse = {
      id: "r",
      model: "gemini",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: null }],
    };
    const native = geminiTransformer.transformResponseOut(ir) as GeminiGenerateContentResponse;
    expect(native.candidates?.[0]?.finishReason).toBeUndefined();
  });
});

// —— streaming inbound: snapshot-compatibility recursion for parallel same-name calls. ——
describe("Gemini transformStreamIn — snapshot compatibility recursion", () => {
  it("reuses one slot for a same-name call whose args object grows compatibly across frames", async () => {
    // Frame 1: { a: 1 }; Frame 2: { a: 1, b: 2 } — object recursion in isSnapshotCompatible
    // (lines 1069-1081) deems them compatible → ONE tool slot, latest full args flushed.
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          { content: { role: "model", parts: [{ functionCall: { name: "f", args: { a: 1 } } }] } },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "f", args: { a: 1, b: 2 } } }],
            },
          },
        ],
      },
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const toolChunks = chunks.filter((c) => (c.choices?.[0]?.delta?.tool_calls?.length ?? 0) > 0);
    expect(toolChunks).toHaveLength(1);
    const tc = toolChunks[0]?.choices?.[0]?.delta?.tool_calls?.[0];
    expect(tc?.function?.name).toBe("f");
    expect(JSON.parse(tc?.function?.arguments ?? "{}")).toEqual({ a: 1, b: 2 });
  });

  it("subtracts streaming cachedContentTokenCount from prompt_tokens (lines 1177-1179)", async () => {
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 4,
          cachedContentTokenCount: 40,
        },
      },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const terminal = chunks.at(-1) as IRChunk;
    expect(terminal.usage?.prompt_tokens).toBe(60);
    expect(terminal.usage?.cached_tokens).toBe(40);
  });
});

// —— streaming outbound: usage cache details + late-name backfill + abort path. ——
describe("Gemini transformStreamOut — usage details, late name, abort", () => {
  it("reconstructs promptTokenCount from cache_creation in prompt_tokens_details", async () => {
    // The cacheCreation fallback (lines 1291-1295) + prompt reconstruction (1296-1299).
    const irChunks: IRChunk[] = [
      { choices: [{ index: 0, delta: { content: "hi" } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 5,
          prompt_tokens_details: { cache_creation_input_tokens: 12, cached_tokens: 8 },
        },
      },
    ] as unknown as IRChunk[];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(irChunks)));
    const terminal = events.at(-1) as GeminiSSEEvent;
    // promptTokenCount = prompt(50) + cached(8) + cacheCreation(12) = 70.
    expect(terminal.usageMetadata?.promptTokenCount).toBe(70);
    expect(terminal.usageMetadata?.cachedContentTokenCount).toBe(8);
    expect(terminal.usageMetadata?.totalTokenCount).toBe(75);
  });

  it("backfills a late-arriving tool name across IR chunks (line 1331-1333)", async () => {
    const irChunks: IRChunk[] = [
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: "late", arguments: "1}" } }],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ] as unknown as IRChunk[];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(irChunks)));
    const terminal = events.at(-1) as GeminiSSEEvent;
    const fc = terminal.candidates?.[0]?.content?.parts?.find((p) => "functionCall" in p) as {
      functionCall?: { name?: string; args?: unknown };
    };
    expect(fc?.functionCall?.name).toBe("late");
    expect(fc?.functionCall?.args).toEqual({ x: 1 });
  });

  it("emits a terminal frame carrying both a reasoning thought part and the text", async () => {
    // Terminal chunk delta has BOTH reasoning_content and content (lines 1342-1345).
    const irChunks: IRChunk[] = [
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "pondered", content: "the answer" },
            finish_reason: "stop",
          },
        ],
      },
    ] as unknown as IRChunk[];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(irChunks)));
    const terminal = events.at(-1) as GeminiSSEEvent;
    const parts = terminal.candidates?.[0]?.content?.parts ?? [];
    expect(parts.find((p) => (p as { thought?: boolean }).thought === true)).toMatchObject({
      text: "pondered",
    });
    expect(parts.find((p) => p.text === "the answer")).toBeDefined();
  });

  it("flushes buffered tool calls + usage when the IR stream ends WITHOUT a finish chunk (abort)", async () => {
    // No finish_reason ever arrives → defensive tail flush (lines 1383-1389).
    const irChunks: IRChunk[] = [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { name: "g", arguments: "{}" } }] },
          },
        ],
      },
      { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ] as unknown as IRChunk[];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(irChunks)));
    const last = events.at(-1) as GeminiSSEEvent;
    const fc = last.candidates?.[0]?.content?.parts?.find((p) => "functionCall" in p) as {
      functionCall?: { name?: string };
    };
    expect(fc?.functionCall?.name).toBe("g");
    expect(last.usageMetadata?.promptTokenCount).toBe(5);
    // no finishReason on a never-finished stream.
    expect(last.candidates?.[0]?.finishReason).toBeUndefined();
  });
});

// —— thinkingConfig reverse band mapping (low/medium/high). ——
describe("Gemini thinkingConfig -> reasoning_effort reverse bands", () => {
  it.each([
    [1024, "low"],
    [8192, "medium"],
    [24576, "high"],
  ])("maps a thinkingBudget of %i to reasoning_effort %s", (budget, effort) => {
    const native = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: budget } },
    } as unknown as GeminiGenerateContentRequest;
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    expect(ir.reasoning_effort).toBe(effort);
  });
});

// —— tool message name fallback (toolNameById + literal default). ——
describe("Gemini outbound tool message name resolution", () => {
  it("derives the functionResponse name from a prior tool_call id when the tool msg omits name", () => {
    // tool message has only tool_call_id → name resolved via toolNameById (lines 760-765).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_w_0", type: "function", function: { name: "weather", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_w_0", content: "sunny" },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const fnResp = native.contents
      .flatMap((c) => c.parts ?? [])
      .find((p) => "functionResponse" in p) as {
      functionResponse?: { name?: string };
    };
    expect(fnResp?.functionResponse?.name).toBe("weather");
  });

  it("falls back to the literal 'tool' name when neither name nor a known id is present", () => {
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "tool", tool_call_id: "unknown_id", content: "result" }],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const fnResp = native.contents
      .flatMap((c) => c.parts ?? [])
      .find((p) => "functionResponse" in p) as {
      functionResponse?: { name?: string };
    };
    expect(fnResp?.functionResponse?.name).toBe("tool");
  });

  it("falls back to 'tool' when the tool message has neither name NOR tool_call_id", () => {
    // tool_call_id undefined → the ternary's `: undefined` arm (line 764) is taken.
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "tool", content: "orphan result" }],
    } as unknown as IRRequest;
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const fnResp = native.contents
      .flatMap((c) => c.parts ?? [])
      .find((p) => "functionResponse" in p) as { functionResponse?: { name?: string } };
    expect(fnResp?.functionResponse?.name).toBe("tool");
  });
});

// —— remaining small branch/statement gaps gathered into one block. ——
describe("Gemini transformer — residual coverage gaps", () => {
  it("routes inline video/* inlineData to an IR video part (inbound)", () => {
    // inlineDataToIRPart video branch (lines 213-215).
    const native = {
      contents: [
        { role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data: "VklE" } }] },
      ],
    };
    const ir = geminiTransformer.transformRequestOut(native) as IRRequest;
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({ type: "video", data: "VklE", mediaType: "video/mp4" });
  });

  it("maps image/audio/video modality token details into the IR token-detail keys", () => {
    // modalityDetailsToIR IMAGE/AUDIO/VIDEO branches (lines 266-274).
    const native = {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 30,
        candidatesTokenCount: 5,
        promptTokensDetails: [
          { modality: "IMAGE", tokenCount: 10 },
          { modality: "AUDIO", tokenCount: 6 },
          { modality: "VIDEO", tokenCount: 4 },
        ],
      },
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    const details = ir.usage?.prompt_tokens_details as Record<string, number>;
    expect(details.image_tokens).toBe(10);
    expect(details.audio_tokens).toBe(6);
    expect(details.video_tokens).toBe(4);
  });

  it("flattens citationMetadata.citationSources into url_citation annotations", () => {
    // groundingToAnnotations citationMetadata branch (lines 323-345) — entirely untested.
    const native = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "cited" }] },
          finishReason: "STOP",
          citationMetadata: {
            citationSources: [
              { uri: "https://src/a", title: "A", startIndex: 0, endIndex: 5 },
              { startIndex: 6, endIndex: 9 },
            ],
          },
        },
      ],
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    const annotations = ir.choices[0]?.message?.annotations ?? [];
    expect(annotations[0]).toMatchObject({
      type: "url_citation",
      url: "https://src/a",
      title: "A",
      start_index: 0,
      end_index: 5,
    });
    // a source with only offsets (no uri/title) still produces an annotation.
    expect(annotations[1]).toMatchObject({ type: "url_citation", start_index: 6, end_index: 9 });
  });

  it("renders an IR document part with neither data nor url as no Gemini part", () => {
    // document part with no data AND no url → returns [] (line 579).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: [{ type: "document", mediaType: "application/pdf" }] }],
    } as unknown as IRRequest;
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const hasFileOrInline = (native.contents[0]?.parts ?? []).some(
      (p) => "fileData" in p || "inlineData" in p,
    );
    expect(hasFileOrInline).toBe(false);
  });

  it("renders an IR video part with neither url nor data as no Gemini media part", () => {
    // video part missing both url and data → returns [] (lines 609-610); a defensive
    // text part is appended (order 29) so the turn is never empty.
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: [{ type: "video", mediaType: "video/mp4" }] }],
    } as unknown as IRRequest;
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const hasMedia = (native.contents[0]?.parts ?? []).some(
      (p) => "fileData" in p || "inlineData" in p,
    );
    expect(hasMedia).toBe(false);
  });

  it("renders an inline IR video part WITHOUT metadata as a plain inlineData part", () => {
    // video with data but no fps/offsets → videoMetadata undefined branch (line 589/605).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: [{ type: "video", data: "VklE", mediaType: "video/mp4" }] },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const part = native.contents[0]?.parts?.find((p) => "inlineData" in p) as {
      inlineData?: { mimeType?: string };
      videoMetadata?: unknown;
    };
    expect(part?.inlineData?.mimeType).toBe("video/mp4");
    expect(part?.videoMetadata).toBeUndefined();
  });

  it("treats malformed tool-call arguments as empty object args (parseArgs catch)", () => {
    // Non-JSON arguments string → parseArgs catch returns {} (lines 673-675).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c0", type: "function", function: { name: "f", arguments: "not json" } },
          ],
        },
      ],
    };
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    const fc = native.contents[0]?.parts?.find((p) => "functionCall" in p) as {
      functionCall?: { args?: unknown };
    };
    expect(fc?.functionCall?.args).toEqual({});
  });

  it("maps an IR json_object response_format to responseMimeType only (outbound)", () => {
    // responseFormatToGenerationConfig json_object branch (line 714/721).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    } as unknown as IRRequest;
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    expect(native.generationConfig?.responseMimeType).toBe("application/json");
    expect("responseSchema" in (native.generationConfig ?? {})).toBe(false);
  });

  it("returns an empty-string content assistant message for a candidate with no usable parts", () => {
    // No text/inlineData/functionCall parts → content '' fallback (line 945).
    const native = {
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.choices[0]?.message).toMatchObject({ role: "assistant", content: "" });
  });

  it("allocates a SECOND streaming slot for a same-name call with incompatible args", async () => {
    // Frame 1 args { a: 1 }; Frame 2 args { a: 2 } — NOT a compatible snapshot
    // extension (isSnapshotCompatible false, line 1081) → two parallel tool slots.
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          { content: { role: "model", parts: [{ functionCall: { name: "f", args: { a: 1 } } }] } },
        ],
      },
      {
        candidates: [
          { content: { role: "model", parts: [{ functionCall: { name: "f", args: { a: 2 } } }] } },
        ],
      },
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const toolChunks = chunks.filter((c) => (c.choices?.[0]?.delta?.tool_calls?.length ?? 0) > 0);
    expect(toolChunks).toHaveLength(2);
  });

  it("reuses a slot for same-name calls whose ARRAY args grow compatibly (array recursion)", async () => {
    // args is an array → isSnapshotCompatible array branch (lines 1063-1067).
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "f", args: { items: [1] } } }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "f", args: { items: [1, 2] } } }],
            },
          },
        ],
      },
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const toolChunks = chunks.filter((c) => (c.choices?.[0]?.delta?.tool_calls?.length ?? 0) > 0);
    expect(toolChunks).toHaveLength(1);
    const tc = toolChunks[0]?.choices?.[0]?.delta?.tool_calls?.[0];
    expect(JSON.parse(tc?.function?.arguments ?? "{}")).toEqual({ items: [1, 2] });
  });

  it("reuses a slot for same-name calls whose STRING args extend by prefix (string branch)", async () => {
    // args carries a string field that grows by prefix → string branch (lines 1060-1061).
    const events: GeminiSSEEvent[] = [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "f", args: { q: "hel" } } }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "f", args: { q: "hello" } } }],
            },
          },
        ],
      },
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const toolChunks = chunks.filter((c) => (c.choices?.[0]?.delta?.tool_calls?.length ?? 0) > 0);
    expect(toolChunks).toHaveLength(1);
    const tc = toolChunks[0]?.choices?.[0]?.delta?.tool_calls?.[0];
    expect(JSON.parse(tc?.function?.arguments ?? "{}")).toEqual({ q: "hello" });
  });

  it("emits streaming usage carrying only candidatesTokenCount (no prompt)", async () => {
    // promptTokenCount undefined → the prompt_tokens spread arm is skipped (line 1179);
    // candidatesTokenCount present → completion_tokens kept (covers the asymmetric usage).
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
        usageMetadata: { candidatesTokenCount: 9 },
      },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const terminal = chunks.at(-1) as IRChunk;
    expect(terminal.usage?.completion_tokens).toBe(9);
    expect(terminal.usage?.prompt_tokens).toBeUndefined();
  });

  it("emits an outbound terminal usage frame with only candidatesTokenCount (prompt undefined)", async () => {
    // transformStreamOut toUsageMetadata: prompt undefined → totalTokenCount from
    // candidates alone (lines 1299, 1305-1307) + reasoning thoughtsTokenCount (1308-1309).
    const irChunks: IRChunk[] = [
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { completion_tokens: 6, reasoning_tokens: 2 },
      },
    ] as unknown as IRChunk[];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(irChunks)));
    const terminal = events.at(-1) as GeminiSSEEvent;
    expect(terminal.usageMetadata?.candidatesTokenCount).toBe(6);
    expect(terminal.usageMetadata?.totalTokenCount).toBe(6);
    expect(terminal.usageMetadata?.thoughtsTokenCount).toBe(2);
    expect(terminal.usageMetadata?.promptTokenCount).toBeUndefined();
  });

  it("emits an outbound terminal usage frame with NEITHER prompt nor candidates (reasoning-only)", async () => {
    // Both prompt and candidates undefined → totalTokenCount spread is skipped (line 1307);
    // only thoughtsTokenCount rides the frame.
    const irChunks: IRChunk[] = [
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { reasoning_tokens: 3 },
      },
    ] as unknown as IRChunk[];
    const events = await collect(geminiTransformer.transformStreamOut(fromArray(irChunks)));
    const terminal = events.at(-1) as GeminiSSEEvent;
    expect(terminal.usageMetadata?.thoughtsTokenCount).toBe(3);
    expect(terminal.usageMetadata?.totalTokenCount).toBeUndefined();
    expect(terminal.usageMetadata?.promptTokenCount).toBeUndefined();
    expect(terminal.usageMetadata?.candidatesTokenCount).toBeUndefined();
  });

  it("emits streaming usage carrying only promptTokenCount (no candidates)", async () => {
    // candidatesTokenCount undefined in streaming usage → completion_tokens skipped (line 1182).
    const events: GeminiSSEEvent[] = [
      { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 11 },
      },
    ] as unknown as GeminiSSEEvent[];
    const chunks = await collect(geminiTransformer.transformStreamIn(fromArray(events)));
    const terminal = chunks.at(-1) as IRChunk;
    expect(terminal.usage?.prompt_tokens).toBe(11);
    expect(terminal.usage?.completion_tokens).toBeUndefined();
  });

  it("maps a non-stream usageMetadata that omits promptTokenCount (candidates only)", () => {
    // promptTokenCount absent in transformResponseIn → prompt_tokens spread skipped (line 982).
    const native = {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { candidatesTokenCount: 4 },
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    expect(ir.usage?.completion_tokens).toBe(4);
    expect(ir.usage?.prompt_tokens).toBeUndefined();
  });

  it("keeps an empty-modality token detail from producing a key (modality === '')", () => {
    // A token detail with no modality string → key undefined → skipped (line 272-275).
    const native = {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        promptTokensDetails: [{ tokenCount: 5 }, { modality: "TEXT", tokenCount: 10 }],
      },
    } as unknown as GeminiGenerateContentResponse;
    const ir = geminiTransformer.transformResponseIn(native) as IRResponse;
    const details = ir.usage?.prompt_tokens_details as Record<string, number>;
    // only the TEXT detail produced a key; the empty-modality one was dropped.
    expect(details.text_tokens).toBe(10);
    // the empty-modality count (5) never appears under any *_tokens key.
    expect(Object.values(details)).not.toContain(5);
  });

  it("maps an IR json_schema response_format whose json_schema is a BARE schema (not wrapped)", () => {
    // json_schema given directly (no nested { schema } key) → the `: rawSchema` arm (line 721).
    const ir: IRRequest = {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    } as unknown as IRRequest;
    const native = geminiTransformer.transformRequestIn(ir) as GeminiGenerateContentRequest;
    expect(native.generationConfig?.responseMimeType).toBe("application/json");
    const schema = native.generationConfig?.responseSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema?.properties?.ok).toBeDefined();
  });
});
