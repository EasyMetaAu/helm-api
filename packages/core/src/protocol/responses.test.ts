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

  it("stashes Responses-only params (store/previous_response_id/metadata/logit_bias/context_management) in provider_raw", async () => {
    const ir = await responsesTransformer.transformRequestOut({
      model: "gpt-4o",
      input: "hi",
      store: true,
      previous_response_id: "resp_prev",
      metadata: { trace: "abc" },
      logit_bias: { "123": -100 },
      context_management: { truncation: "auto" },
    });
    expect(ir.provider_raw?.store).toBe(true);
    expect(ir.provider_raw?.previous_response_id).toBe("resp_prev");
    expect(ir.provider_raw?.metadata).toEqual({ trace: "abc" });
    expect(ir.provider_raw?.logit_bias).toEqual({ "123": -100 });
    expect(ir.provider_raw?.context_management).toEqual({ truncation: "auto" });
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
      provider_raw: { context_management: { truncation: "auto" } },
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

  it("rejects stateful tool-output continuation when previous_response_id history is unavailable", async () => {
    expect(() =>
      responsesTransformer.transformRequestOut({
        model: "gpt-4o",
        previous_response_id: "resp_prev",
        input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
      }),
    ).toThrow(/previous_response_id continuation is not supported/);
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
