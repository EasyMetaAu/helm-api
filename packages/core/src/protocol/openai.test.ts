import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { IRRequest, IRResponse } from "./ir.js";
import { openaiTransformer } from "./openai.js";
import { TransformerRegistry } from "./registry.js";

// OpenAI Chat transformer = the hub IDENTITY transform (docs/05). Because the IR
// takes the OpenAI Chat Completions shape as its skeleton, OpenAI in/out must be
// lossless round-trippable — it is the correctness anchor for the whole protocol
// layer. "Identity" still means: Zod-validate inbound (fail-closed), and stash
// raw usage/finish_reason in provider_raw for cross-protocol reconstruction.

// A representative OpenAI request: system + user + assistant tool_calls +
// role:"tool" backfill + tools + max_tokens + stream:true.
const fullRequest = {
  model: "gpt-4o",
  messages: [
    { role: "system", content: "be terse" },
    { role: "user", content: "weather in SF?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"SF"}' },
        },
      ],
    },
    { role: "tool", content: "72F sunny", tool_call_id: "call_abc" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "get_weather", parameters: { type: "object" } },
    },
  ],
  tool_choice: "auto",
  temperature: 0.3,
  max_tokens: 256,
  stream: true,
  response_format: { type: "json_object" },
} as const;

describe("openaiTransformer — request identity round-trip", () => {
  // test #1: req -> IR -> req is semantically equivalent (fields, tool_call_id,
  // arguments string all preserved).
  it("round-trips a representative request losslessly (transformRequestOut -> transformRequestIn)", async () => {
    const ir = await openaiTransformer.transformRequestOut(fullRequest);
    const back = (await openaiTransformer.transformRequestIn(ir)) as typeof fullRequest;
    expect(back.model).toBe("gpt-4o");
    expect(back.messages).toEqual(fullRequest.messages);
    expect(back.tools).toEqual(fullRequest.tools);
    expect(back.tool_choice).toBe("auto");
    expect(back.temperature).toBe(0.3);
    expect(back.max_tokens).toBe(256);
    expect(back.stream).toBe(true);
    expect(back.response_format).toEqual({ type: "json_object" });
    // tool_call arguments stay a JSON string, never a parsed object
    expect(back.messages[2]?.tool_calls?.[0]?.function.arguments).toBe('{"city":"SF"}');
    expect(back.messages[3]?.tool_call_id).toBe("call_abc");
  });
});

describe("openaiTransformer — response identity round-trip", () => {
  // test #2: res -> IR -> res is lossless on choices/message/finish_reason/usage.
  it("round-trips a representative response losslessly", async () => {
    const upstream = {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "It is 72F and sunny." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 },
    };
    const ir = await openaiTransformer.transformResponseIn(upstream);
    const back = (await openaiTransformer.transformResponseOut(ir)) as typeof upstream;
    expect(back.id).toBe("chatcmpl-1");
    expect(back.model).toBe("gpt-4o");
    expect(back.choices[0]?.message).toEqual({
      role: "assistant",
      content: "It is 72F and sunny.",
    });
    expect(back.choices[0]?.finish_reason).toBe("stop");
    expect(back.usage.prompt_tokens).toBe(50);
    expect(back.usage.completion_tokens).toBe(8);
  });
});

describe("openaiTransformer — usage split (pit #2)", () => {
  // test #3: prompt_tokens=100, cached_tokens=30 -> IR cached_tokens=30,
  // input = prompt - cached = 70; rewriting OpenAI does not double-bill cache.
  it("splits cached tokens (input = prompt - cached) and never double-bills", async () => {
    const upstream = {
      id: "chatcmpl-2",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    };
    const ir: IRResponse = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.usage?.cached_tokens).toBe(30);
    // input = prompt - cached
    expect(ir.usage?.prompt_tokens).toBe(70);
    expect(ir.usage?.completion_tokens).toBe(5);

    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      usage: { prompt_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    // OpenAI's prompt_tokens is the FULL prompt (cached + non-cached); rebuilding
    // it must add cached back so we do not under/over-report (no ~10x error).
    expect(back.usage.prompt_tokens).toBe(100);
    expect(back.usage.prompt_tokens_details?.cached_tokens).toBe(30);
  });
});

describe("openaiTransformer — finish_reason raw value (pit #1)", () => {
  // test #4: after transformResponseIn, finish_reason is a legal enum AND the raw
  // value is stashed in provider_raw.stop_reason.
  it("keeps finish_reason as a legal enum and stashes the raw value in provider_raw.stop_reason", async () => {
    const upstream = {
      id: "chatcmpl-3",
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 256 },
    };
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.choices[0]?.finish_reason).toBe("length");
    expect(ir.provider_raw?.stop_reason).toBe("length");
    // raw usage is also stashed for billing/reconstruction
    expect(ir.provider_raw?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 256 });
  });
});

describe("openaiTransformer — fail-closed request validation (pit: identity != passthrough)", () => {
  // test #5: missing model or messages throws ZodError, never silently passes.
  // The 5-method contract allows sync OR async; defer the call inside an async fn
  // so a synchronous throw surfaces as a rejected promise either way.
  const callRequestOut = (req: unknown) => async () => openaiTransformer.transformRequestOut(req);

  it("throws ZodError when `model` is missing", async () => {
    await expect(callRequestOut({ messages: [{ role: "user", content: "x" }] })()).rejects.toThrow(
      ZodError,
    );
  });

  it("throws ZodError when `messages` is missing", async () => {
    await expect(callRequestOut({ model: "gpt-4o" })()).rejects.toThrow(ZodError);
  });
});

describe("openaiTransformer — endpoint + registry", () => {
  // test #6: endPoint is /v1/chat/completions and registry enumerates it.
  it("declares the /v1/chat/completions endPoint", () => {
    expect(openaiTransformer.name).toBe("openai");
    expect(openaiTransformer.endPoint).toBe("/v1/chat/completions");
  });

  it("registers into TransformerRegistry and is enumerable by endPoint", () => {
    const reg = new TransformerRegistry();
    reg.register(openaiTransformer);
    expect(reg.get("openai")).toBe(openaiTransformer);
    const eps = reg.endpoints();
    const hit = eps.find((e) => e.endPoint === "/v1/chat/completions");
    expect(hit?.transformer).toBe(openaiTransformer);
  });
});

// Type-level sanity: the transformer satisfies the IR contract shapes.
const _irReq: IRRequest = { model: "m", messages: [] };
void _irReq;
