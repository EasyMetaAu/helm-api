import { describe, expect, it } from "vitest";
import type { IRRequest, IRResponse } from "../ir.js";
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
      usage: { prompt_tokens: 30, completion_tokens: 10, cached_tokens: 5, reasoning_tokens: 4 },
    };
    const native = geminiTransformer.transformResponseOut(ir) as GeminiGenerateContentResponse;
    const um = native.usageMetadata;
    // prompt = prompt_tokens + cached; total = prompt + completion.
    expect(um?.promptTokenCount).toBe(35);
    expect(um?.candidatesTokenCount).toBe(10);
    expect(um?.totalTokenCount).toBe(45);
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
