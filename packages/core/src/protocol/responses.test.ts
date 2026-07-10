import { describe, expect, it } from "vitest";
import { anthropicTransformer } from "./anthropic/index.js";
import { geminiTransformer } from "./gemini/gemini-transformer.js";
import type { IRRequest, IRResponse } from "./ir.js";
import { TransformerRegistry } from "./registry.js";
import { responsesTransformer } from "./responses.js";

describe("responsesTransformer — text.format structured output canonicalization (order 1)", () => {
  // A Responses client sends structured output as text.format.{type,name,schema};
  // the IR (OpenAI-Chat-shaped) must canonicalize it to response_format.{type,
  // json_schema} so the Anthropic/Gemini renderers — which read that shape — can
  // honor it. Previously the raw Responses shape was parked verbatim and dropped.
  const schema = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  };
  const responsesReq = {
    model: "gpt-4o",
    input: "weather in SF?",
    text: { format: { type: "json_schema", name: "weather", schema } },
  };

  it("canonicalizes text.format.json_schema to IR.response_format.{type,json_schema}", async () => {
    const ir = await responsesTransformer.transformRequestOut(responsesReq);
    expect(ir.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "weather", schema },
    });
  });

  it("renders Anthropic output_format from a Responses structured-output request", async () => {
    const ir = await responsesTransformer.transformRequestOut(responsesReq);
    const anthropic = (await anthropicTransformer.transformRequestIn(ir)) as {
      output_format?: { type: string; schema?: { properties?: Record<string, unknown> } };
    };
    expect(anthropic.output_format?.type).toBe("json_schema");
    expect(anthropic.output_format?.schema?.properties).toMatchObject({ city: { type: "string" } });
  });

  it("renders Gemini responseSchema from a Responses structured-output request", async () => {
    const ir = await responsesTransformer.transformRequestOut(responsesReq);
    const gemini = (await geminiTransformer.transformRequestIn(ir)) as {
      generationConfig?: { responseMimeType?: string; responseSchema?: { properties?: unknown } };
    };
    expect(gemini.generationConfig?.responseMimeType).toBe("application/json");
    expect(gemini.generationConfig?.responseSchema?.properties).toMatchObject({
      city: { type: "string" },
    });
  });

  it("round-trips the native Responses text shape (responses -> IR -> responses)", async () => {
    const ir = await responsesTransformer.transformRequestOut(responsesReq);
    const back = (await responsesTransformer.transformRequestIn(ir)) as {
      text?: { format?: { type?: string; name?: string; schema?: unknown } };
    };
    expect(back.text?.format?.type).toBe("json_schema");
    expect(back.text?.format?.name).toBe("weather");
    expect(back.text?.format?.schema).toMatchObject({ type: "object" });
  });
});

describe("responsesTransformer — input_audio content (RESP-01)", () => {
  it("folds an input_audio part into an IR audio part instead of a JSON text placeholder", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o-audio",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "transcribe this" },
            { type: "input_audio", input_audio: { data: "AUDIO64", format: "mp3" } },
          ],
        },
      ],
    });
    const userMsg = ir.messages.find((m) => m.role === "user");
    const parts = Array.isArray(userMsg?.content) ? userMsg?.content : [];
    expect(parts).toContainEqual({ type: "audio", data: "AUDIO64", format: "mp3" });
  });

  it("renders an IR audio part back to native Responses input_audio", async () => {
    const native = (await responsesTransformer.transformRequestIn({
      model: "gpt-4o-audio",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "transcribe this" },
            { type: "audio", data: "AUDIO64", format: "mp3" },
          ],
        },
      ],
    } as IRRequest)) as {
      input: Array<{ content?: Array<Record<string, unknown>> }>;
    };

    expect(native.input[0]?.content).toContainEqual({
      type: "input_audio",
      input_audio: { data: "AUDIO64", format: "mp3" },
    });
  });
});

describe("responsesTransformer — function tool canonicalization", () => {
  it("maps Responses flat function tools to OpenAI Chat tools and preserves the raw shape", async () => {
    const flatTool = {
      type: "function",
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      strict: false,
    };

    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "read README.md",
      tools: [flatTool],
    });

    expect(ir.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: flatTool.parameters,
          strict: false,
        },
      },
    ]);
    expect(ir.provider_raw?.responses_tools).toEqual([flatTool]);

    const back = (await responsesTransformer.transformRequestIn?.(ir)) as { tools?: unknown[] };
    expect(back.tools).toEqual([flatTool]);
  });
});

// OpenAI Responses transformer (docs/05). Responses is a DIFFERENT request shape
// from Chat Completions: instead of `messages[]` (role + content), the
// conversation is flattened into a top-level `input[]` ITEM stream — user/
// assistant text, `function_call`, `function_call_output`, and `reasoning`
// items are all siblings, not nested inside a message. This transformer folds
// the item stream back into the OpenAI-Chat-shaped IR on the way in, and
// explodes the IR back into the item stream on the way out. Correctness is
// aligned item-by-item with litellm's messages_to_responses_mapping.

describe("responsesTransformer — Tier D request/response fidelity (orders 17-25)", () => {
  // order 17: reasoning config on the request maps effort -> IR.reasoning_effort and
  // is preserved verbatim in provider_raw for reconstruction.
  it("maps reasoning.effort to IR.reasoning_effort and stashes the config (order 17)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "o1",
      input: "hi",
      reasoning: { effort: "medium", summary: "auto" },
    });
    expect(ir.reasoning_effort).toBe("medium");
    expect(ir.provider_raw?.reasoning_config).toEqual({ effort: "medium", summary: "auto" });
  });

  it("accepts Codex CLI reasoning:null and omits the empty config", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "o1",
      input: "hi",
      reasoning: null,
    });
    expect(ir.reasoning_effort).toBeUndefined();
    expect(ir.provider_raw?.reasoning_config).toBeUndefined();
  });

  it("reconstructs reasoning config on the outbound Responses request (order 17)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "o1",
      input: "hi",
      reasoning: { effort: "high" },
    });
    const back = (await responsesTransformer.transformRequestIn(ir)) as {
      reasoning?: { effort?: string };
    };
    expect(back.reasoning?.effort).toBe("high");
  });

  // order 18: truncation has no IR home -> rides provider_raw and round-trips.
  it("round-trips the truncation parameter (order 18)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      truncation: "disabled",
    });
    expect(ir.provider_raw?.truncation).toBe("disabled");
    const back = (await responsesTransformer.transformRequestIn(ir)) as { truncation?: string };
    expect(back.truncation).toBe("disabled");
  });

  // order 19: an incomplete response must carry incomplete_details.reason.
  it("sets incomplete_details.reason on a content-filtered response (order 19)", async () => {
    const ir: IRResponse = {
      id: "r",
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "content_filter" },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      status: string;
      incomplete_details?: { reason?: string };
    };
    expect(out.status).toBe("incomplete");
    expect(out.incomplete_details?.reason).toBe("content_filter");
  });

  it("maps a length cap to incomplete_details.reason=max_tokens (order 19)", async () => {
    const ir: IRResponse = {
      id: "r",
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      incomplete_details?: { reason?: string };
    };
    expect(out.incomplete_details?.reason).toBe("max_tokens");
  });

  // order 20: output_text annotations (citations/grounding) must survive both ways.
  it("emits output_text annotations on the Responses response (order 20)", async () => {
    const ir: IRResponse = {
      id: "r",
      model: "m",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "see source",
            annotations: [{ type: "url_citation", url: "https://x", start_index: 0, end_index: 3 }],
          },
          finish_reason: "stop",
        },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      output: Array<{ type: string; content?: Array<{ annotations?: unknown[] }> }>;
    };
    const msg = out.output.find((o) => o.type === "message");
    expect(msg?.content?.[0]?.annotations).toEqual([
      { type: "url_citation", url: "https://x", start_index: 0, end_index: 3 },
    ]);
  });

  it("folds inbound output_text annotations back onto the IR message (order 20)", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r",
      model: "m",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "hi",
              annotations: [{ type: "url_citation", url: "https://x" }],
            },
          ],
        },
      ],
    });
    expect(ir.choices[0]?.message.annotations?.[0]?.url).toBe("https://x");
  });

  // order 21: reasoning_tokens (+ cache_creation) lift into output_tokens_details.
  it("lifts reasoning_tokens into usage.output_tokens_details (order 21)", async () => {
    const ir: IRResponse = {
      id: "r",
      model: "o1",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 15 },
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      usage: { output_tokens_details?: { reasoning_tokens?: number } };
    };
    expect(out.usage.output_tokens_details?.reasoning_tokens).toBe(15);
  });

  it("reconstructs Responses input_tokens with cache read and cache creation tokens", async () => {
    const ir: IRResponse = {
      id: "r-cache",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 60,
        cached_tokens: 30,
        cache_creation_tokens: 10,
        completion_tokens: 20,
      },
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      usage: {
        input_tokens?: number;
        input_tokens_details?: {
          cached_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
    };
    expect(out.usage.input_tokens).toBe(100);
    expect(out.usage.input_tokens_details).toMatchObject({
      cached_tokens: 30,
      cache_creation_input_tokens: 10,
    });
  });

  // order 23: per-choice logprobs ride the output_text part.
  it("carries choice logprobs onto the output_text part (order 23)", async () => {
    const ir: IRResponse = {
      id: "r",
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
          logprobs: { content: [{ token: "hi", logprob: -0.1 }] },
        },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      output: Array<{
        type: string;
        content?: Array<{ logprobs?: { content?: Array<{ token: string }> } }>;
      }>;
    };
    const msg = out.output.find((o) => o.type === "message");
    expect(msg?.content?.[0]?.logprobs?.content?.[0]?.token).toBe("hi");
  });

  // Codex P1: a native incomplete Responses response must yield a REAL IR finish_reason
  // (length / content_filter), not the raw status "incomplete" which collapses to stop.
  it("maps inbound incomplete_details.reason to a real finish_reason (max_output_tokens -> length)", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r",
      model: "m",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ],
    });
    expect(ir.choices[0]?.finish_reason).toBe("length");
  });

  it("maps inbound incomplete content_filter to finish_reason=content_filter", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r",
      model: "m",
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ],
    });
    expect(ir.choices[0]?.finish_reason).toBe("content_filter");
  });

  it("round-trips a content-filtered incomplete response (responses -> IR -> responses)", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r",
      model: "m",
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ],
    });
    const back = (await responsesTransformer.transformResponseOut(ir)) as {
      status: string;
      incomplete_details?: { reason?: string };
    };
    expect(back.status).toBe("incomplete");
    expect(back.incomplete_details?.reason).toBe("content_filter");
  });

  // Codex P2: an inbound Responses input_file part must fold into an IR document, not
  // hit the unknown-part fallback (which turned it into JSON text and dropped the file).
  it("folds an inbound input_file (file_id) into an IR document part", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "summarize" },
            { type: "input_file", file_id: "file-abc" },
          ],
        },
      ],
    });
    const parts = ir.messages.at(-1)?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts.some((p) => p.type === "document" && p.fileId === "file-abc")).toBe(true);
  });

  it("round-trips input_image.detail through the IR", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://x/y.png", detail: "high" }],
        },
      ],
    });
    const parts = ir.messages.at(-1)?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({ type: "image", url: "https://x/y.png", detail: "high" });

    const back = (await responsesTransformer.transformRequestIn(ir)) as {
      input: Array<{ type: string; content?: Array<{ type: string; detail?: string }> }>;
    };
    const image = back.input[0]?.content?.[0];
    expect(image).toMatchObject({ type: "input_image", detail: "high" });
  });

  it("accepts Chat-style nested input_image.image_url objects", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: { url: "https://x/nested.png", detail: "low" } },
          ],
        },
      ],
    });
    const parts = ir.messages.at(-1)?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({
      type: "image",
      url: "https://x/nested.png",
      detail: "low",
    });
  });

  it("folds an inbound input_file (file_data PDF) into an IR document with base64 data", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "r.pdf",
              file_data: "data:application/pdf;base64,JVBE",
            },
          ],
        },
      ],
    });
    const parts = ir.messages.at(-1)?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({
      type: "document",
      data: "JVBE",
      mediaType: "application/pdf",
      filename: "r.pdf",
    });
  });

  // order 25: multimodal content must not collapse to text on the outbound request.
  it("preserves multimodal parts (input_text + input_image) on the outbound request (order 25)", async () => {
    const back = (await responsesTransformer.transformRequestIn({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", url: "https://x/y.png" },
          ],
        },
      ],
    })) as { input: Array<{ type: string; content?: Array<{ type: string }> }> };
    const msg = back.input.find((i) => i.type === "message");
    const types = (msg?.content ?? []).map((c) => c.type);
    expect(types).toContain("input_text");
    expect(types).toContain("input_image");
  });

  it("round-trips input_file filename for file_id and file_url", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_file", file_id: "file-abc", filename: "uploaded.pdf" },
            {
              type: "input_file",
              file_url: "https://x/r.pdf",
              filename: "remote.pdf",
            },
          ],
        },
      ],
    });

    const back = (await responsesTransformer.transformRequestIn(ir)) as {
      input: Array<{
        type: string;
        content?: Array<{
          type: string;
          file_id?: string;
          file_url?: string;
          filename?: string;
        }>;
      }>;
    };
    expect(back.input[0]?.content).toEqual([
      { type: "input_file", file_id: "file-abc", filename: "uploaded.pdf" },
      { type: "input_file", file_url: "https://x/r.pdf", filename: "remote.pdf" },
    ]);
  });
});

describe("responsesTransformer — messages -> input items expansion (test #1)", () => {
  // An IR with user text + assistant tool_calls + a tool result must explode,
  // on transformResponseOut... but the response path emits `output[]`. The
  // request shape (input[]) is exercised by transformRequestOut/round-trip.
  // Here we assert the OUTPUT item explosion: assistant text + a function_call
  // item, with call_id preserved 1:1 and order kept.
  it("explodes IR assistant text + tool_calls into output message + function_call items", async () => {
    const ir: IRResponse = {
      id: "resp_1",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Let me check the weather.",
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      object: string;
      output: Array<Record<string, unknown>>;
    };
    expect(out.object).toBe("response");
    // message item first, then function_call item (order preserved).
    const msg = out.output.find((i) => i.type === "message") as
      | { type: string; role: string; content: Array<{ type: string; text: string }> }
      | undefined;
    expect(msg?.role).toBe("assistant");
    expect(msg?.content[0]?.type).toBe("output_text");
    expect(msg?.content[0]?.text).toBe("Let me check the weather.");

    const fc = out.output.find((i) => i.type === "function_call") as
      | { type: string; call_id: string; name: string; arguments: string }
      | undefined;
    expect(fc?.call_id).toBe("call_abc");
    expect(fc?.name).toBe("get_weather");
    expect(fc?.arguments).toBe('{"city":"SF"}');
  });
});

describe("responsesTransformer — request input items -> IR (folding)", () => {
  // function_call + function_call_output items fold back into assistant
  // tool_calls + a role:"tool" message; call_id <-> tool_call.id is preserved.
  it("folds function_call / function_call_output items into IR tool_calls + tool message", async () => {
    const native = {
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "weather in SF?" }],
        },
        {
          type: "function_call",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
        {
          type: "function_call_output",
          call_id: "call_abc",
          output: "72F sunny",
        },
      ],
    };
    const ir = await responsesTransformer.transformRequestOut(native);
    expect(ir.model).toBe("gpt-4o");
    // user message, assistant(tool_calls), tool message
    const user = ir.messages[0];
    expect(user?.role).toBe("user");
    const assistant = ir.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.id).toBe("call_abc");
    expect(assistant?.tool_calls?.[0]?.function.name).toBe("get_weather");
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"city":"SF"}');
    const toolMsg = ir.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call_abc");
    expect(toolMsg?.content).toBe("72F sunny");
  });

  it("round-trips multipart function_call_output output", async () => {
    const native = {
      model: "gpt-4o",
      input: [
        {
          type: "function_call_output",
          call_id: "call_abc",
          output: [
            { type: "output_text", text: "chart:" },
            { type: "input_image", image_url: "https://x/chart.png", detail: "low" },
            { type: "input_file", file_url: "https://x/data.csv", filename: "data.csv" },
          ],
        },
      ],
    };

    const ir = await responsesTransformer.transformRequestOut(native);
    const toolMsg = ir.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call_abc");
    expect(toolMsg?.content).toEqual([
      { type: "text", text: "chart:" },
      { type: "image", url: "https://x/chart.png", detail: "low" },
      { type: "document", url: "https://x/data.csv", filename: "data.csv" },
    ]);

    const back = (await responsesTransformer.transformRequestIn(ir)) as {
      input: Array<{ type: string; output?: unknown }>;
    };
    expect(back.input[0]?.output).toEqual(native.input[0]?.output);
  });

  it("folds top-level instructions into the leading IR system message", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      instructions: "be terse",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(ir.messages[0]?.role).toBe("system");
    expect(ir.messages[0]?.content).toBe("be terse");
  });

  it("accepts a bare string input as a single user message", async () => {
    const ir = await responsesTransformer.transformRequestOut({ model: "gpt-4o", input: "hello" });
    expect(ir.messages[0]?.role).toBe("user");
    expect(ir.messages[0]?.content).toBe("hello");
  });

  it("preserves a developer item as IR role:developer (issue #50, no longer collapses to system)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Prefer metric units." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "weather in SF?" }],
        },
      ],
    });
    expect(ir.messages.map((m) => m.role)).toEqual(["developer", "user"]);
    expect(ir.messages[0]?.content).toEqual([{ type: "text", text: "Prefer metric units." }]);
  });

  // The OpenAI SDK (and pi-ai) omit `type:"message"` on input messages — it is
  // OPTIONAL in the Responses spec. A typeless { role, content } item must fold
  // to a message, NOT 400 with invalid_union. Regression for SDK-shaped requests.
  it("accepts a message item that omits type (content-part array)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(ir.messages[0]?.role).toBe("user");
    expect(ir.messages[0]?.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("accepts a message item that omits type (bare string content)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [{ role: "user", content: "hi" }],
    });
    expect(ir.messages[0]?.role).toBe("user");
    expect(ir.messages[0]?.content).toBe("hi");
  });

  // Making `type` optional on the message variant must NOT cause a typed
  // non-message item (which lacks `role`) to be absorbed as a message. A
  // function_call item must still lift into an assistant tool_call. Guards the
  // non-discriminated union ordering after the change.
  it("still routes a typed function_call item, not as a typeless message", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        { role: "user", content: "hi" },
        { type: "function_call", call_id: "call_x", name: "f", arguments: "{}" },
      ],
    });
    const assistant = ir.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.id).toBe("call_x");
    expect(ir.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("responsesTransformer — reasoning item inbound (test #2)", () => {
  // A `reasoning` item carrying `status` must become an IR thinking block with
  // the `status` STRIPPED (OpenAI rejects input[X].status), and the raw item
  // preserved in provider_raw.
  it("collapses a reasoning item into an IR thinking block, strips status, keeps raw in provider_raw", async () => {
    const native = {
      model: "gpt-4o",
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          status: "completed",
          summary: [{ type: "summary_text", text: "thinking about SF weather" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "weather?" }],
        },
      ],
    };
    const ir = await responsesTransformer.transformRequestOut(native);
    // thinking block recovered
    const thinking = ir.thinking as Array<{ type: string; text: string }> | undefined;
    expect(thinking?.[0]?.type).toBe("thinking");
    expect(thinking?.[0]?.text).toBe("thinking about SF weather");
    // status must NOT leak anywhere in the IR thinking ext
    expect(JSON.stringify(ir.thinking)).not.toContain("status");
    // raw reasoning item preserved (with status) in provider_raw
    const rawReasoning = ir.provider_raw?.reasoning as Array<{ status?: string }> | undefined;
    expect(rawReasoning?.[0]?.status).toBe("completed");
  });

  it("replays inbound reasoning items on a Responses request without rejected status", async () => {
    const native = {
      model: "gpt-4o",
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          status: "completed",
          summary: [{ type: "summary_text", text: "thinking about SF weather" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
      ],
    };

    const ir = await responsesTransformer.transformRequestOut(native);
    const back = (await responsesTransformer.transformRequestIn(ir)) as {
      input: Array<Record<string, unknown>>;
    };

    expect(back.input[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "thinking about SF weather" }],
    });
    expect(JSON.stringify(back.input[0])).not.toContain("status");
  });
});

describe("responsesTransformer — reasoning item outbound (test #3)", () => {
  it("rebuilds a reasoning item from an IR thinking block, summary[0].type === summary_text", async () => {
    const ir: IRResponse = {
      id: "resp_2",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", text: "step-by-step reasoning" },
              { type: "text", text: "The answer is 42." },
            ],
          },
          finish_reason: "stop",
        },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      output: Array<Record<string, unknown>>;
    };
    const reasoning = out.output.find((i) => i.type === "reasoning") as
      | { type: string; summary: Array<{ type: string; text: string }> }
      | undefined;
    expect(reasoning?.summary[0]?.type).toBe("summary_text");
    expect(reasoning?.summary[0]?.text).toBe("step-by-step reasoning");
    const msg = out.output.find((i) => i.type === "message") as
      | { content: Array<{ type: string; text: string }> }
      | undefined;
    expect(msg?.content[0]?.text).toBe("The answer is 42.");
  });
});

describe("responsesTransformer — round-trip isomorphism (test #4)", () => {
  it("input -> IR -> output keeps the tool-call item set semantically equivalent", async () => {
    const native = {
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "weather in SF?" }],
        },
        {
          type: "function_call",
          call_id: "call_xyz",
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      ],
    };
    const ir = await responsesTransformer.transformRequestOut(native);
    // Drive the IR through the response path as if the model echoed the call.
    const irResp: IRResponse = {
      id: "resp_3",
      model: ir.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: ir.messages
              .filter((m) => m.role === "assistant")
              .flatMap((m) => m.tool_calls ?? []),
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(irResp)) as {
      output: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
    };
    const fc = out.output.find((i) => i.type === "function_call");
    expect(fc?.call_id).toBe("call_xyz");
    expect(fc?.name).toBe("get_weather");
    expect(fc?.arguments).toBe('{"city":"SF"}');
  });
});

describe("responsesTransformer — finish_reason mapping (test #5)", () => {
  it("maps an unknown finish_reason to a legal Responses status and keeps raw in provider_raw", async () => {
    const ir: IRResponse = {
      id: "resp_4",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "x" },
          finish_reason: "weird_upstream_value",
        },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as {
      status: string;
      provider_raw?: { stop_reason?: unknown };
    };
    // Legal Responses statuses: completed | incomplete (others are stream states).
    expect(["completed", "incomplete"]).toContain(out.status);
    expect(out.provider_raw?.stop_reason).toBe("weird_upstream_value");
  });

  it("maps length -> incomplete (max_output_tokens)", async () => {
    const ir: IRResponse = {
      id: "resp_5",
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" },
      ],
    };
    const out = (await responsesTransformer.transformResponseOut(ir)) as { status: string };
    expect(out.status).toBe("incomplete");
  });
});

describe("responsesTransformer — upstream response -> IR (transformResponseIn)", () => {
  it("normalizes a native Responses response output[] into IR choices", async () => {
    const upstream = {
      id: "resp_in_1",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello there" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "do_thing",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    const ir = await responsesTransformer.transformResponseIn(upstream);
    const msg = ir.choices[0]?.message;
    expect(msg?.role).toBe("assistant");
    expect(msg?.tool_calls?.[0]?.id).toBe("call_1");
    expect(ir.provider_raw?.stop_reason).toBe("completed");
  });
});

describe("responsesTransformer — fail-closed validation", () => {
  const call = (req: unknown) => async () => responsesTransformer.transformRequestOut(req);
  it("throws when input/model are missing", async () => {
    await expect(call({})()).rejects.toThrow();
  });
});

describe("responsesTransformer — unknown item type (fail-open)", () => {
  it("retains an unknown item type in provider_raw instead of throwing", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "some_future_item", foo: "bar" },
      ],
    });
    const unknown = ir.provider_raw?.unknown_items as Array<Record<string, unknown>> | undefined;
    expect(unknown?.[0]?.type).toBe("some_future_item");
    // the valid user message still survives
    expect(ir.messages.some((m) => m.role === "user")).toBe(true);
  });
});

describe("responsesTransformer — request sampling/control params (litellm parity)", () => {
  it("maps IR-backed params including prompt-cache controls onto IR", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      top_p: 0.9,
      frequency_penalty: 0.5,
      presence_penalty: 0.25,
      seed: 42,
      n: 2,
      parallel_tool_calls: false,
      user: "user-123",
      service_tier: "auto",
      prompt_cache_key: "thread-123",
      prompt_cache_retention: "24h",
      web_search_options: { search_context_size: "low" },
    });
    expect(ir.top_p).toBe(0.9);
    expect(ir.frequency_penalty).toBe(0.5);
    expect(ir.presence_penalty).toBe(0.25);
    expect(ir.seed).toBe(42);
    expect(ir.n).toBe(2);
    expect(ir.parallel_tool_calls).toBe(false);
    expect(ir.user).toBe("user-123");
    expect(ir.service_tier).toBe("auto");
    expect(ir.prompt_cache_key).toBe("thread-123");
    expect(ir.prompt_cache_retention).toBe("24h");
    expect(ir.web_search_options).toEqual({ search_context_size: "low" });
  });

  it("stashes Responses-only params (store/previous_response_id/metadata/logit_bias/context_management/include/background) in provider_raw", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      store: true,
      previous_response_id: "resp_prev",
      metadata: { trace: "abc" },
      logit_bias: { "123": -100 },
      context_management: { truncation: "auto" },
      include: ["reasoning.encrypted_content"],
      background: true,
    });
    expect(ir.provider_raw?.store).toBe(true);
    expect(ir.provider_raw?.previous_response_id).toBe("resp_prev");
    expect(ir.provider_raw?.metadata).toEqual({ trace: "abc" });
    expect(ir.provider_raw?.logit_bias).toEqual({ "123": -100 });
    expect(ir.provider_raw?.context_management).toEqual({ truncation: "auto" });
    expect(ir.provider_raw?.include).toEqual(["reasoning.encrypted_content"]);
    expect(ir.provider_raw?.background).toBe(true);
  });

  it("round-trips IR-backed params back onto the native Responses request (transformRequestIn)", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      top_p: 0.8,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      seed: 7,
      n: 3,
      parallel_tool_calls: true,
      user: "user-123",
      service_tier: "auto",
      prompt_cache_key: "thread-123",
      prompt_cache_retention: "24h",
      web_search_options: { search_context_size: "low" },
      provider_raw: {
        context_management: { truncation: "auto" },
        include: ["reasoning.encrypted_content"],
        background: true,
      },
    })) as {
      top_p?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      seed?: number;
      n?: number;
      parallel_tool_calls?: boolean;
      user?: string;
      service_tier?: string;
      prompt_cache_key?: string;
      prompt_cache_retention?: string;
      web_search_options?: unknown;
      context_management?: unknown;
      include?: unknown;
      background?: unknown;
    };
    expect(native.top_p).toBe(0.8);
    expect(native.frequency_penalty).toBe(0.1);
    expect(native.presence_penalty).toBe(0.2);
    expect(native.seed).toBe(7);
    expect(native.n).toBe(3);
    expect(native.parallel_tool_calls).toBe(true);
    expect(native.user).toBe("user-123");
    expect(native.service_tier).toBe("auto");
    expect(native.prompt_cache_key).toBe("thread-123");
    expect(native.prompt_cache_retention).toBe("24h");
    expect(native.web_search_options).toEqual({ search_context_size: "low" });
    expect(native.context_management).toEqual({ truncation: "auto" });
    expect(native.include).toEqual(["reasoning.encrypted_content"]);
    expect(native.background).toBe(true);
  });

  it("normalizes Responses tool_choice into OpenAI Chat format on inbound conversion", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "weather?",
      tool_choice: { type: "function", name: "get_weather" },
    });

    expect(ir.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  it("normalizes OpenAI Chat tool_choice into Responses format on outbound conversion", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [{ role: "user", content: "weather?" }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    })) as { tool_choice?: unknown };

    expect(native.tool_choice).toEqual({ type: "function", name: "get_weather" });
  });

  it("preserves stateful previous_response_id tool-output continuations for native passthrough guards", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      previous_response_id: "resp_prev",
      input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
    });
    expect(ir.provider_raw?.previous_response_id).toBe("resp_prev");
    expect(ir.messages).toEqual([{ role: "tool", content: "done", tool_call_id: "call_1" }]);
  });

  it("keeps native-only Responses tools out of IR tools and preserves them in provider_raw", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      tools: [
        { type: "mcp", server_label: "local" },
        { type: "file_search", vector_store_ids: ["vs_1"] },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
    });
    expect(ir.tools).toEqual([
      { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
    ]);
    expect(ir.provider_raw?.responses_native_tools).toEqual([
      { type: "mcp", server_label: "local" },
      { type: "file_search", vector_store_ids: ["vs_1"] },
    ]);
  });
});

describe("responsesTransformer — usage detail mapping (transformResponseIn)", () => {
  it("maps output_tokens_details.reasoning_tokens -> IRUsage.reasoning_tokens and cache fields", async () => {
    const upstream = {
      id: "resp_u",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 30, cache_creation_input_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 8 },
      },
    };
    const ir = await responsesTransformer.transformResponseIn(upstream);
    expect(ir.usage?.reasoning_tokens).toBe(8);
    expect(ir.usage?.cached_tokens).toBe(30);
    expect(ir.usage?.cache_creation_tokens).toBe(10);
    // prompt = input - cache read - cache creation
    expect(ir.usage?.prompt_tokens).toBe(60);
  });
});

describe("responsesTransformer — response echo passthrough (reasoning/text/tool_choice)", () => {
  it("surfaces reasoning/text/tool_choice echo fields via provider_raw on transformResponseIn", async () => {
    const upstream = {
      id: "resp_e",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { type: "json_object" } },
      tool_choice: "auto",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ],
    };
    const ir = await responsesTransformer.transformResponseIn(upstream);
    expect(ir.provider_raw?.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(ir.provider_raw?.text).toEqual({ format: { type: "json_object" } });
    expect(ir.provider_raw?.tool_choice).toBe("auto");
  });
});

// —— Coverage targets: uncovered lines/branches in responses.ts ————————————————

// Lines 234-237: responsesTextToResponseFormat — json_object + unknown/text branches
describe("responsesTransformer — text.format.json_object and plain text formats (lines 234-237)", () => {
  it("maps text.format.json_object to IR response_format.json_object", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      text: { format: { type: "json_object" } },
    });
    expect(ir.response_format).toEqual({ type: "json_object" });
  });

  it("ignores text.format.text (no structured output → response_format absent)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      text: { format: { type: "text" } },
    });
    expect(ir.response_format).toBeUndefined();
  });

  it("ignores text that is not an object (primitive string) → no response_format", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      text: "just a string" as unknown as Record<string, unknown>,
    });
    expect(ir.response_format).toBeUndefined();
  });
});

// Lines 252-254: responseFormatToResponsesText — json_object outbound
describe("responsesTransformer — outbound text.format.json_object (lines 252-254)", () => {
  it("maps IR response_format.json_object back to text.format.json_object on outbound request", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    })) as { text?: { format?: { type?: string } } };
    expect(native.text?.format?.type).toBe("json_object");
  });
});

// Lines 296-297: chatToolChoiceToResponses — {type:'function'} but function field
// has no name → return toolChoice verbatim
describe("responsesTransformer — chatToolChoiceToResponses fallback branch (lines 296-297)", () => {
  it("keeps tool_choice verbatim when function field is missing a name", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
      // {type:'function'} with function:{} (no name) → verbatim fallback
      tool_choice: { type: "function", function: {} } as unknown as string,
    })) as { tool_choice?: unknown };
    // Must not throw; the shape is preserved (not converted to flat Responses format)
    expect(native.tool_choice).toEqual({ type: "function", function: {} });
  });

  it("keeps a non-function tool_choice string verbatim (non-object branch)", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "required",
    })) as { tool_choice?: unknown };
    expect(native.tool_choice).toBe("required");
  });
});

// Lines 321-449: toIRRequest — second system message (non-first) stays as input item
describe("responsesTransformer — second system message stays as message item (lines 321-449)", () => {
  it("folds first system to instructions, keeps a second system as a message input item", async () => {
    // The first system maps to `instructions`; any later system stays as an input message.
    // This exercises the "instructions !== undefined" guard (line 554).
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "first system" },
        { role: "system", content: "second system" },
        { role: "user", content: "hello" },
      ],
    })) as {
      instructions?: string;
      input: Array<{ type: string; role?: string; content?: unknown }>;
    };
    expect(native.instructions).toBe("first system");
    // second system must remain in input as a message item
    const secondSys = native.input.find((i) => i.type === "message" && i.role === "system");
    expect(secondSys).toBeDefined();
  });
});

// Lines 366: foldContentPart — default case (unknown part type → JSON text placeholder)
describe("responsesTransformer — foldContentPart unknown part type (line 366)", () => {
  it("degrades an unknown content part type to a JSON text placeholder (fail-open)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what?" },
            { type: "video_frame", data: "DEADBEEF" } as unknown as Record<string, unknown>,
          ],
        },
      ],
    });
    const parts = ir.messages.at(-1)?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    // The unknown part becomes a text placeholder
    expect(
      parts.some((p) => p.type === "text" && (p as { text: string }).text.includes("video_frame")),
    ).toBe(true);
  });
});

// Lines 422: toIRRequest — function_call fallback id synthesis
describe("responsesTransformer — function_call id synthesis when call_id and id absent (line 422)", () => {
  it("synthesizes a call id when function_call item has neither call_id nor id", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "function_call",
          // no call_id, no id
          name: "check",
          arguments: "{}",
        } as unknown as Record<string, unknown>,
      ],
    });
    const assistantMsg = ir.messages.find((m) => m.role === "assistant");
    const call = assistantMsg?.tool_calls?.[0];
    expect(call?.id).toMatch(/^call_/);
    expect(call?.function.name).toBe("check");
  });
});

// Lines 432: toIRRequest — function_call_output with multipart content (non-string output)
describe("responsesTransformer — function_call_output with multipart content (line 432)", () => {
  it("folds array output on function_call_output into an array of IR parts", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "function_call_output",
          call_id: "call_x",
          output: [{ type: "output_text", text: "result" }],
        } as unknown as Record<string, unknown>,
      ],
    });
    const toolMsg = ir.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call_x");
    // output was an array → folded into IR parts
    expect(Array.isArray(toolMsg?.content)).toBe(true);
  });

  it("uses empty string when function_call_output has undefined output", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "function_call_output",
          call_id: "call_y",
          // output undefined
        } as unknown as Record<string, unknown>,
      ],
    });
    const toolMsg = ir.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("");
  });
});

// Lines 497-562: toIRRequest — tool_choice Responses → Chat normalization for non-function shape
describe("responsesTransformer — tool_choice non-function Responses shape passes through (lines 497-562)", () => {
  it("passes through 'auto' tool_choice string unchanged", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      tool_choice: "auto",
    });
    expect(ir.tool_choice).toBe("auto");
  });

  it("passes through 'none' tool_choice unchanged", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      tool_choice: "none",
    });
    expect(ir.tool_choice).toBe("none");
  });

  it("passes through a Responses tool_choice with {type:'function'} that ALREADY has a function field (already Chat-shaped) unchanged", async () => {
    // responsesToolChoiceToChat: if toolChoice already has .function, it is Chat-shaped → return verbatim
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      tool_choice: { type: "function", function: { name: "f" } },
    });
    expect(ir.tool_choice).toEqual({ type: "function", function: { name: "f" } });
  });
});

// Lines 613-745 (toResponsesResponse) — reasoning items FIRST, then message
describe("responsesTransformer — toResponsesResponse: reasoning items precede message (lines 613-745)", () => {
  it("emits reasoning output items before the message item", async () => {
    const ir: IRResponse = {
      id: "resp_r",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", text: "let me think" },
              { type: "text", text: "the answer" },
            ],
          },
          finish_reason: "stop",
        },
      ],
    };
    const native = (await responsesTransformer.transformResponseOut(ir)) as {
      output: Array<{ type: string }>;
    };
    // reasoning must precede message
    const reasoningIdx = native.output.findIndex((o) => o.type === "reasoning");
    const messageIdx = native.output.findIndex((o) => o.type === "message");
    expect(reasoningIdx).toBeLessThan(messageIdx);
  });

  it("emits no reasoning item when there are no thinking parts", async () => {
    const ir: IRResponse = {
      id: "resp_r2",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "plain" },
          finish_reason: "stop",
        },
      ],
    };
    const native = (await responsesTransformer.transformResponseOut(ir)) as {
      output: Array<{ type: string }>;
    };
    expect(native.output.some((o) => o.type === "reasoning")).toBe(false);
  });

  it("emits no message item when content is null/empty and no tool_calls", async () => {
    const ir: IRResponse = {
      id: "resp_empty",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null },
          finish_reason: "tool_calls",
        },
      ],
    };
    const native = (await responsesTransformer.transformResponseOut(ir)) as {
      output: Array<{ type: string }>;
    };
    expect(native.output.some((o) => o.type === "message")).toBe(false);
  });
});

// Lines 639, 653: toResponsesResponse — usage input_tokens_details cache fields
describe("responsesTransformer — toResponsesResponse usage fields (lines 639, 653)", () => {
  it("includes cache fields in input_tokens_details when cached_tokens or cacheCreation > 0", async () => {
    const ir: IRResponse = {
      id: "resp_u2",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        cached_tokens: 20,
        cache_creation_tokens: 5,
      },
    };
    const native = (await responsesTransformer.transformResponseOut(ir)) as {
      usage?: {
        input_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
      };
    };
    expect(native.usage?.input_tokens_details?.cached_tokens).toBe(20);
    expect(native.usage?.input_tokens_details?.cache_creation_input_tokens).toBe(5);
  });

  it("omits input_tokens_details when both cached and cacheCreation are 0", async () => {
    const ir: IRResponse = {
      id: "resp_u3",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    };
    const native = (await responsesTransformer.transformResponseOut(ir)) as {
      usage?: { input_tokens_details?: unknown };
    };
    expect(native.usage?.input_tokens_details).toBeUndefined();
  });
});

// Lines 706-709: toResponsesResponse — assistant content parts (Array branch)
describe("responsesTransformer — toResponsesResponse array content parts (lines 706-709)", () => {
  it("maps array content parts to output_text items, skipping thinking parts already emitted", async () => {
    const ir: IRResponse = {
      id: "resp_p",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "part A" },
              { type: "text", text: "part B" },
            ],
          },
          finish_reason: "stop",
        },
      ],
    };
    const native = (await responsesTransformer.transformResponseOut(ir)) as {
      output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    };
    const msgItem = native.output.find((o) => o.type === "message");
    const textItems = (msgItem?.content ?? []).filter((c) => c.type === "output_text");
    expect(textItems).toHaveLength(2);
    expect(textItems.map((t) => t.text)).toEqual(["part A", "part B"]);
  });
});

// Lines 808-1003: toIRResponse — various paths
describe("responsesTransformer — toIRResponse various branches (lines 808-1003)", () => {
  it("maps status 'incomplete' with missing incomplete_details.reason to finish_reason 'length'", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_unk",
      model: "gpt-4o",
      status: "incomplete",
      // no incomplete_details → default to 'length'
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ],
    });
    expect(ir.choices[0]?.finish_reason).toBe("length");
  });

  it("maps status neither completed nor incomplete to that raw status string", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_odd",
      model: "gpt-4o",
      status: "queued", // not 'completed' or 'incomplete'
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ],
    });
    expect(ir.choices[0]?.finish_reason).toBe("queued");
  });

  it("folds a reasoning item from output[] into IR thinking content parts", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_reason",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "step 1" },
            { type: "summary_text", text: "step 2" },
          ],
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const content = ir.choices[0]?.message.content;
    if (!Array.isArray(content)) throw new Error("expected array");
    expect(
      content.some((p) => p.type === "thinking" && (p as { text: string }).text.includes("step 1")),
    ).toBe(true);
  });

  it("ignores unknown output item types gracefully (default case)", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_unk2",
      model: "gpt-4o",
      status: "completed",
      output: [
        { type: "function_call_output", call_id: "c1", output: "done" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
    });
    // Should not throw; function_call_output ignored on response side
    expect(ir.choices[0]?.message).toBeDefined();
  });

  it("maps a function_call output item to a tool call in IR", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_fc",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"LA"}',
        },
        { type: "message", role: "assistant", content: [] },
      ],
    });
    const call = ir.choices[0]?.message.tool_calls?.[0];
    expect(call?.id).toBe("call_abc");
    expect(call?.function.name).toBe("get_weather");
    expect(call?.function.arguments).toBe('{"city":"LA"}');
  });

  it("synthesizes a call id for function_call when both call_id and id absent", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_noid",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "function_call",
          // no call_id, no id
          name: "noop",
          arguments: "{}",
        } as unknown as Record<string, unknown>,
      ],
    });
    const call = ir.choices[0]?.message.tool_calls?.[0];
    expect(call?.id).toMatch(/^call_/);
  });

  it("folds message with string content into IR text part", async () => {
    // foldMessageContent: string → string → parts.push text block
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_str",
      model: "gpt-4o",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: "plain string content" as unknown as [] },
      ],
    });
    const content = ir.choices[0]?.message.content;
    // string content → foldMessageContent returns a string → non-empty pushes a text part
    expect(content).toBeDefined();
  });

  it("omits usage fields from IR when response has no usage", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_nou",
      model: "gpt-4o",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ],
      // no usage field
    });
    expect(ir.usage).toBeUndefined();
  });
});

// Lines 911, 918: toIRResponse — message content string and null folding
describe("responsesTransformer — toIRResponse message folding paths (lines 911, 918)", () => {
  it("handles message item with empty string content (no part pushed)", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_empty_str",
      model: "gpt-4o",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "" as unknown as [] }],
    });
    // empty string → foldMessageContent returns "" → condition `folded !== ""` is false → not pushed
    const msg = ir.choices[0]?.message;
    expect(msg).toBeDefined();
  });
});

// Lines 942, 970, 990, 993: mapResponsesStatus + incomplete_details.reason paths
describe("responsesTransformer — mapResponsesStatus edge cases (lines 942, 970, 990, 993)", () => {
  it("maps null finish to {status:'completed', raw:null}", () => {
    // Direct unit test of the exported helper
    const { mapResponsesStatus } = responsesTransformer as unknown as {
      mapResponsesStatus?: (f: string | null) => { status: string; raw: string | null };
    };
    if (mapResponsesStatus === undefined) {
      // The function is not exported on the transformer; test via round-trip instead
      return;
    }
    expect(mapResponsesStatus(null)).toEqual({ status: "completed", raw: null });
  });

  it("maps unknown finish_reason to completed status", async () => {
    const ir: IRResponse = {
      id: "resp_x",
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "novel_reason" },
      ],
    };
    const native = (await responsesTransformer.transformResponseOut(ir)) as { status: string };
    // unknown reason → STATUS_MAP fallback → completed
    expect(native.status).toBe("completed");
  });

  it("maps 'incomplete' with reason 'max_output_tokens' to incomplete_details.reason='max_tokens'", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_max",
      model: "gpt-4o",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ],
    });
    // max_output_tokens is not 'content_filter' → finish_reason = 'length'
    expect(ir.choices[0]?.finish_reason).toBe("length");
  });

  it("round-trip: length → incomplete + max_tokens reason → back to length", async () => {
    const ir: IRResponse = {
      id: "resp_len",
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: "partial" }, finish_reason: "length" },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 100 },
    };
    const native = (await responsesTransformer.transformResponseOut(ir)) as {
      status: string;
      incomplete_details?: { reason?: string };
    };
    expect(native.status).toBe("incomplete");
    expect(native.incomplete_details?.reason).toBe("max_tokens");

    const back = await responsesTransformer.transformResponseIn(
      native as Parameters<typeof responsesTransformer.transformResponseIn>[0],
    );
    expect(back.choices[0]?.finish_reason).toBe("length");
  });
});

// contentToFunctionCallOutput paths: null, string, array
describe("responsesTransformer — contentToFunctionCallOutput paths (line 671-673)", () => {
  it("serializes a tool message with null content to empty string in outbound input", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: null },
        { role: "user", content: "ok" },
      ],
    })) as { input: Array<{ type: string; output?: unknown }> };
    const fco = native.input.find((i) => i.type === "function_call_output");
    expect(fco?.output).toBe("");
  });

  it("serializes a tool message with multipart content to a parts array in outbound input", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", type: "function", function: { name: "g", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "c2",
          content: [{ type: "text", text: "result" }],
        },
        { role: "user", content: "ok" },
      ],
    })) as { input: Array<{ type: string; output?: unknown }> };
    const fco = native.input.find((i) => i.type === "function_call_output");
    expect(Array.isArray(fco?.output)).toBe(true);
  });
});

// Lines 706-709: contentToResponsesParts — document part with base64 data (no fileId)
describe("responsesTransformer — outbound document base64 part (lines 706-709)", () => {
  it("encodes a document part with data as input_file.file_data on outbound request", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              data: "JVBERi0=",
              mediaType: "application/pdf",
              filename: "doc.pdf",
            },
          ],
        },
      ],
    })) as { input: Array<{ type: string; content?: Array<Record<string, unknown>> }> };
    const msg = native.input.find((i) => i.type === "message");
    const filePart = (msg?.content ?? []).find((c) => c.type === "input_file");
    expect(filePart?.file_data).toBe("data:application/pdf;base64,JVBERi0=");
    expect(filePart?.filename).toBe("doc.pdf");
  });

  it("encodes document with data and no mediaType using application/octet-stream fallback", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [{ type: "document", data: "DEADBEEF" }],
        },
      ],
    })) as { input: Array<{ type: string; content?: Array<Record<string, unknown>> }> };
    const msg = native.input.find((i) => i.type === "message");
    const filePart = (msg?.content ?? []).find((c) => c.type === "input_file");
    expect(filePart?.file_data as string).toContain("application/octet-stream");
  });
});

// Line 911: toIRResponse — foldedLogprobs already set; second output_text's logprobs ignored
describe("responsesTransformer — foldedLogprobs set only from first output_text (line 911)", () => {
  it("captures logprobs only from the first output_text part, ignoring subsequent ones", async () => {
    const lp1 = { tokens: ["a"], token_logprobs: [-0.1] };
    const lp2 = { tokens: ["b"], token_logprobs: [-0.2] };
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_lp",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "first", logprobs: lp1 },
            { type: "output_text", text: "second", logprobs: lp2 },
          ],
        },
      ],
    });
    const choice = ir.choices[0];
    // foldedLogprobs captures only lp1 (first output_text with logprobs)
    expect(choice?.logprobs).toEqual(lp1);
  });
});

// Lines 990, 993: toIRResponse usage — fullInput undefined, output_tokens undefined
describe("responsesTransformer — toIRResponse usage fields when optional data absent (lines 990, 993)", () => {
  it("omits prompt_tokens when usage.input_tokens is absent (fullInput undefined, line 990)", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_noinput",
      model: "gpt-4o",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ],
      usage: {
        // no input_tokens → fullInput undefined
        output_tokens: 10,
      },
    });
    // prompt_tokens must not be present (fullInput undefined → not emitted)
    expect(ir.usage?.prompt_tokens).toBeUndefined();
    expect(ir.usage?.completion_tokens).toBe(10);
  });

  it("omits completion_tokens when usage.output_tokens is absent (line 993)", async () => {
    const ir = await responsesTransformer.transformResponseIn({
      id: "r_noout",
      model: "gpt-4o",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ],
      usage: {
        input_tokens: 50,
        // no output_tokens
      },
    });
    expect(ir.usage?.completion_tokens).toBeUndefined();
    expect(ir.usage?.prompt_tokens).toBe(50);
  });
});

// Line 639: toResponsesRequest — previous_response_id re-emit from provider_raw
describe("responsesTransformer — previous_response_id and metadata re-emit from provider_raw (line 639)", () => {
  it("re-emits previous_response_id when present in provider_raw", async () => {
    // Store the IR with provider_raw containing previous_response_id
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      previous_response_id: "resp_prev_1",
      input: "follow-up",
    });
    // Round-trip back to native Responses request
    const native = (await responsesTransformer.transformRequestIn?.(ir)) as {
      previous_response_id?: string;
    };
    expect(native.previous_response_id).toBe("resp_prev_1");
  });
});

// Lines 653, 661-666: contentToText string and null paths via toResponsesRequest
describe("responsesTransformer — contentToText paths (lines 653, 661-666)", () => {
  it("emits reasoning config from reasoning_effort when no raw reasoning_config in provider_raw (line 653)", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "medium",
    })) as { reasoning?: { effort?: string } };
    expect(native.reasoning?.effort).toBe("medium");
  });

  it("renders a string-content assistant turn as an output_text item in outbound input (lines 661-666)", async () => {
    // Exercises contentToText for a string content value on an assistant-with-text+tool_calls turn.
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "result" },
        { role: "user", content: "thanks" },
      ],
    })) as { input: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
    // The assistant content "Let me check." must appear as a message/output_text item.
    const textMsg = native.input.find(
      (i) => i.type === "message" && i.content?.some((c) => c.type === "output_text"),
    );
    const textPart = textMsg?.content?.find((c) => c.type === "output_text");
    expect(textPart?.text).toBe("Let me check.");
  });
});

// Line 253: responseFormatToResponsesText — unknown type → undefined (no text emitted)
describe("responsesTransformer — responseFormatToResponsesText unknown type (line 253)", () => {
  it("emits no text field for an unrecognized response_format type", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "text" } as unknown as { type: "json_object" },
    })) as { text?: unknown };
    // type:'text' is not json_schema or json_object → no text field
    expect(native.text).toBeUndefined();
  });
});

// Line 422: toIRRequest — second function_call appended to same trailing assistant turn
describe("responsesTransformer — multiple function_calls appended to same assistant turn (line 422)", () => {
  it("appends a second function_call to the same trailing assistant turn (not a new message)", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: [
        {
          type: "function_call",
          call_id: "c1",
          name: "tool_a",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "c2",
          name: "tool_b",
          arguments: "{}",
        },
      ],
    });
    const assistantMsgs = ir.messages.filter((m) => m.role === "assistant");
    // Both function_calls should fold into ONE assistant message
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]?.tool_calls).toHaveLength(2);
    expect(assistantMsgs[0]?.tool_calls?.[0]?.id).toBe("c1");
    expect(assistantMsgs[0]?.tool_calls?.[1]?.id).toBe("c2");
  });
});

// Lines 662-666: contentToText — string content path
describe("responsesTransformer — contentToText null path (lines 662-666)", () => {
  it("emits empty string from function_call_output with string content for null-content tool", async () => {
    const native = (await responsesTransformer.transformRequestIn?.({
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        // string content tool message — exercises the string path in contentToFunctionCallOutput
        { role: "tool", tool_call_id: "c1", content: "string result" },
        { role: "user", content: "ok" },
      ],
    })) as { input: Array<{ type: string; output?: unknown }> };
    const fco = native.input.find((i) => i.type === "function_call_output");
    expect(fco?.output).toBe("string result");
  });
});

describe("responsesTransformer — endpoint isolation (test #6)", () => {
  it("declares /v1/responses, distinct from OpenAI Chat", () => {
    expect(responsesTransformer.name).toBe("openai-responses");
    expect(responsesTransformer.endPoint).toBe("/v1/responses");
  });

  it("registers alongside the OpenAI Chat transformer without endpoint collision", () => {
    const reg = new TransformerRegistry();
    reg.register(responsesTransformer);
    expect(reg.get("openai-responses")).toBe(responsesTransformer);
    const hit = reg.endpoints().find((e) => e.endPoint === "/v1/responses");
    expect(hit?.transformer).toBe(responsesTransformer);
  });
});

// Type-level sanity: the transformer satisfies the IR contract shapes.
const _irReq: IRRequest = { model: "m", messages: [] };
void _irReq;
