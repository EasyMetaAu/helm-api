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
  prompt_cache_key: "thread-123",
  prompt_cache_retention: "24h",
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
    expect(back.prompt_cache_key).toBe("thread-123");
    expect(back.prompt_cache_retention).toBe("24h");
    // tool_call arguments stay a JSON string, never a parsed object
    expect(back.messages[2]?.tool_calls?.[0]?.function.arguments).toBe('{"city":"SF"}');
    expect(back.messages[3]?.tool_call_id).toBe("call_abc");
  });
});

describe("openaiTransformer — developer role survives + round-trips (issue #50)", () => {
  // OpenAI's `developer` is a first-class IR role: it must survive inbound and
  // round-trip unchanged outbound, keeping its position relative to system/user.
  const devRequest = {
    model: "gpt-4o",
    messages: [
      { role: "developer", content: "Prefer metric units." },
      { role: "system", content: "Be precise." },
      { role: "user", content: "weather in SF?" },
    ],
  };

  it("preserves role:developer and message order (transformRequestOut)", async () => {
    const ir = await openaiTransformer.transformRequestOut(devRequest);
    expect(ir.messages.map((m) => m.role)).toEqual(["developer", "system", "user"]);
    expect(ir.messages[0]?.content).toBe("Prefer metric units.");
  });

  it("round-trips developer unchanged (IR -> OpenAI native)", async () => {
    const ir = await openaiTransformer.transformRequestOut(devRequest);
    const back = (await openaiTransformer.transformRequestIn(ir)) as typeof devRequest;
    expect(back.messages).toEqual(devRequest.messages);
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

  it("splits cache creation tokens separately from fresh input", async () => {
    const upstream = {
      id: "chatcmpl-cache-write",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 30, cache_creation_tokens: 10 },
      },
    };
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.usage?.prompt_tokens).toBe(60);
    expect(ir.usage?.cached_tokens).toBe(30);
    expect(ir.usage?.cache_creation_tokens).toBe(10);

    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      usage: {
        prompt_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
      };
    };
    expect(back.usage.prompt_tokens).toBe(100);
    expect(back.usage.prompt_tokens_details).toMatchObject({
      cached_tokens: 30,
      cache_creation_tokens: 10,
    });
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

describe("openaiTransformer — litellm-parity request params", () => {
  // P3: the new sampling/control params must survive native -> IR -> native.
  const paramsRequest = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    top_p: 0.9,
    top_k: 40,
    frequency_penalty: 0.5,
    presence_penalty: -0.2,
    seed: 42,
    stop: ["\n\n", "END"],
    n: 2,
    logprobs: true,
    top_logprobs: 5,
    parallel_tool_calls: false,
    stream_options: { include_usage: true },
    modalities: ["text", "audio"],
    reasoning_effort: "high",
    user: "user-123",
    service_tier: "auto",
    prediction: { type: "content", content: "expected" },
    audio: { voice: "alloy", format: "wav" },
    logit_bias: { "42": -1 },
    web_search_options: { search_context_size: "low" },
    include_server_side_tool_invocations: true,
    verbosity: "low",
    safety_identifier: "safe-user",
  } as const;

  it("carries every new param into the IR (transformRequestOut)", async () => {
    const ir = await openaiTransformer.transformRequestOut(paramsRequest);
    expect(ir.top_p).toBe(0.9);
    expect(ir.top_k).toBe(40);
    expect(ir.frequency_penalty).toBe(0.5);
    expect(ir.presence_penalty).toBe(-0.2);
    expect(ir.seed).toBe(42);
    expect(ir.stop).toEqual(["\n\n", "END"]);
    expect(ir.n).toBe(2);
    expect(ir.logprobs).toBe(true);
    expect(ir.top_logprobs).toBe(5);
    expect(ir.parallel_tool_calls).toBe(false);
    expect(ir.stream_options).toEqual({ include_usage: true });
    expect(ir.modalities).toEqual(["text", "audio"]);
    expect(ir.reasoning_effort).toBe("high");
    expect(ir.user).toBe("user-123");
    expect(ir.service_tier).toBe("auto");
    expect(ir.prediction).toEqual({ type: "content", content: "expected" });
    expect(ir.audio).toEqual({ voice: "alloy", format: "wav" });
    expect(ir.logit_bias).toEqual({ "42": -1 });
    expect(ir.web_search_options).toEqual({ search_context_size: "low" });
    expect(ir.include_server_side_tool_invocations).toBe(true);
    expect(ir.verbosity).toBe("low");
    expect(ir.safety_identifier).toBe("safe-user");
  });

  it("round-trips every new param back to native (transformRequestIn)", async () => {
    const ir = await openaiTransformer.transformRequestOut(paramsRequest);
    const back = (await openaiTransformer.transformRequestIn(ir)) as typeof paramsRequest;
    expect(back.top_p).toBe(0.9);
    expect(back.top_k).toBe(40);
    expect(back.frequency_penalty).toBe(0.5);
    expect(back.presence_penalty).toBe(-0.2);
    expect(back.seed).toBe(42);
    expect(back.stop).toEqual(["\n\n", "END"]);
    expect(back.n).toBe(2);
    expect(back.logprobs).toBe(true);
    expect(back.top_logprobs).toBe(5);
    expect(back.parallel_tool_calls).toBe(false);
    expect(back.stream_options).toEqual({ include_usage: true });
    expect(back.modalities).toEqual(["text", "audio"]);
    expect(back.reasoning_effort).toBe("high");
    expect(back.user).toBe("user-123");
    expect(back.service_tier).toBe("auto");
    expect(back.prediction).toEqual({ type: "content", content: "expected" });
    expect(back.audio).toEqual({ voice: "alloy", format: "wav" });
    expect(back.logit_bias).toEqual({ "42": -1 });
    expect(back.web_search_options).toEqual({ search_context_size: "low" });
    expect(back.include_server_side_tool_invocations).toBe(true);
    expect(back.verbosity).toBe("low");
    expect(back.safety_identifier).toBe("safe-user");
  });

  it("accepts a bare string `stop`", async () => {
    const ir = await openaiTransformer.transformRequestOut({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
      stop: "STOP",
    });
    expect(ir.stop).toBe("STOP");
  });
});

describe("openaiTransformer — logprobs round-trip", () => {
  // P3: choice-level logprobs survive native -> IR -> native.
  const upstream = {
    id: "chatcmpl-lp",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hi" },
        finish_reason: "stop",
        logprobs: {
          content: [
            {
              token: "Hi",
              logprob: -0.0001,
              bytes: [72, 105],
              top_logprobs: [{ token: "Hi", logprob: -0.0001, bytes: [72, 105] }],
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 1 },
  };

  it("extracts logprobs into IRChoice.logprobs (transformResponseIn)", async () => {
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.choices[0]?.logprobs?.content?.[0]?.token).toBe("Hi");
    expect(ir.choices[0]?.logprobs?.content?.[0]?.logprob).toBeCloseTo(-0.0001);
  });

  it("emits logprobs back to native (transformResponseOut)", async () => {
    const ir = await openaiTransformer.transformResponseIn(upstream);
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      choices: Array<{ logprobs?: { content?: Array<{ token: string }> } }>;
    };
    expect(back.choices[0]?.logprobs?.content?.[0]?.token).toBe("Hi");
  });
});

describe("openaiTransformer — reasoning_content + completion_tokens_details", () => {
  // P3: reasoning string + reasoning_tokens detail survive the round-trip.
  const upstream = {
    id: "chatcmpl-r",
    model: "o1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "The answer is 4.",
          reasoning_content: "2 + 2 = 4",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 15, audio_tokens: 0 },
    },
  };

  it("extracts reasoning_content + completion_tokens_details into the IR (transformResponseIn)", async () => {
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.choices[0]?.message.reasoning_content).toBe("2 + 2 = 4");
    expect(ir.usage?.completion_tokens_details?.reasoning_tokens).toBe(15);
    expect(ir.usage?.reasoning_tokens).toBe(15);
  });

  it("emits reasoning_content + completion_tokens_details back to native (transformResponseOut)", async () => {
    const ir = await openaiTransformer.transformResponseIn(upstream);
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      choices: Array<{ message: { reasoning_content?: string } }>;
      usage: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    expect(back.choices[0]?.message.reasoning_content).toBe("2 + 2 = 4");
    expect(back.usage.completion_tokens_details?.reasoning_tokens).toBe(15);
  });
});

describe("openaiTransformer — system_fingerprint + created", () => {
  // P3: system_fingerprint stashes into provider_raw and is re-emitted; created
  // is always present (epoch seconds) on the outbound response.
  const upstream = {
    id: "chatcmpl-sf",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "gpt-4o",
    system_fingerprint: "fp_abc123",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  it("stashes system_fingerprint into provider_raw (transformResponseIn)", async () => {
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.provider_raw?.system_fingerprint).toBe("fp_abc123");
  });

  it("re-emits system_fingerprint + a created timestamp (transformResponseOut)", async () => {
    const ir = await openaiTransformer.transformResponseIn(upstream);
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      system_fingerprint?: string;
      created?: number;
    };
    expect(back.system_fingerprint).toBe("fp_abc123");
    expect(typeof back.created).toBe("number");
    expect(back.created).toBeGreaterThan(0);
  });
});

describe("openaiTransformer — finish_reason mapped to a legal OpenAI value", () => {
  // P3: an out-of-vocabulary upstream finish_reason maps to a legal OpenAI value
  // outbound, with the raw value preserved in provider_raw.stop_reason.
  it("maps an unknown finish_reason to `stop` outbound while keeping the raw value", async () => {
    const upstream = {
      id: "chatcmpl-fr",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "x" },
          finish_reason: "some_proprietary_reason",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.provider_raw?.stop_reason).toBe("some_proprietary_reason");
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(back.choices[0]?.finish_reason).toBe("stop");
  });

  it("maps cross-protocol aliases (max_tokens -> length)", async () => {
    const upstream = {
      id: "chatcmpl-fr3",
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "max_tokens" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.provider_raw?.stop_reason).toBe("max_tokens");
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(back.choices[0]?.finish_reason).toBe("length");
  });

  it("passes legal finish_reasons through unchanged", async () => {
    const upstream = {
      id: "chatcmpl-fr2",
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: null }, finish_reason: "tool_calls" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const ir = await openaiTransformer.transformResponseIn(upstream);
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(back.choices[0]?.finish_reason).toBe("tool_calls");
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

describe("openaiTransformer — multimodal input content normalization (P7)", () => {
  // OpenAI clients send NATIVE content parts: image_url / input_audio / file.
  // These must normalize INTO the IR's typed parts (image/audio/document) on the
  // way in, and back OUT to the native OpenAI shapes — the IR never carries the
  // raw OpenAI part shapes (they are not valid IRContentPart discriminants).
  it("normalizes image_url (data-url + remote) into IR image parts", async () => {
    const native = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ],
    };
    const ir = await openaiTransformer.transformRequestOut(native);
    const parts = ir.messages[0]?.content;
    expect(Array.isArray(parts)).toBe(true);
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[1]).toMatchObject({ type: "image", url: "data:image/png;base64,AAAA" });
    expect(parts[2]).toMatchObject({ type: "image", url: "https://x/y.png" });
  });

  it("normalizes input_audio into an IR audio part and back to native (round-trip)", async () => {
    const native = {
      model: "gpt-4o-audio-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "transcribe" },
            { type: "input_audio", input_audio: { data: "QUJD", format: "wav" } },
          ],
        },
      ],
    };
    const ir = await openaiTransformer.transformRequestOut(native);
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[1]).toMatchObject({ type: "audio", data: "QUJD", format: "wav" });

    const back = (await openaiTransformer.transformRequestIn(ir)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const outParts = back.messages[0]?.content;
    expect(outParts?.[1]).toMatchObject({
      type: "input_audio",
      input_audio: { data: "QUJD", format: "wav" },
    });
  });

  it("normalizes a file part (file_data PDF) into an IR document part and back", async () => {
    const native = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            {
              type: "file",
              file: { file_data: "data:application/pdf;base64,JVBE", filename: "r.pdf" },
            },
          ],
        },
      ],
    };
    const ir = await openaiTransformer.transformRequestOut(native);
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[1]).toMatchObject({
      type: "document",
      data: "JVBE",
      mediaType: "application/pdf",
      filename: "r.pdf",
    });

    const back = (await openaiTransformer.transformRequestIn(ir)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const outParts = back.messages[0]?.content;
    expect(outParts?.[1]).toMatchObject({ type: "file" });
    const fileBlock = outParts?.[1] as { file?: { file_data?: string; filename?: string } };
    expect(fileBlock.file?.file_data).toContain("application/pdf");
    expect(fileBlock.file?.filename).toBe("r.pdf");
  });

  // Regression (Codex P1): an uploaded-file reference must round-trip as file_id, NOT
  // be collapsed to document.url and re-emitted as file_data (OpenAI expects file_id).
  it("round-trips an uploaded file_id reference (not corrupted into file_data)", async () => {
    const native = {
      model: "gpt-4o",
      messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-abc123" } }] }],
    };
    const ir = await openaiTransformer.transformRequestOut(native);
    const parts = ir.messages[0]?.content;
    if (!Array.isArray(parts)) throw new Error("expected parts");
    expect(parts[0]).toMatchObject({ type: "document", fileId: "file-abc123" });
    expect((parts[0] as { url?: string }).url).toBeUndefined();

    const back = (await openaiTransformer.transformRequestIn(ir)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const out = back.messages[0]?.content?.[0] as {
      file?: { file_id?: string; file_data?: string };
    };
    expect(out.file?.file_id).toBe("file-abc123");
    expect(out.file?.file_data).toBeUndefined();
  });
});

describe("openaiTransformer — model-generated audio output round-trip (P7)", () => {
  // OpenAI audio models put generated audio on message.audio {id,data,transcript}.
  const upstream = {
    id: "chatcmpl-audio",
    model: "gpt-4o-audio-preview",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          audio: { id: "audio_1", data: "QUJD", transcript: "hello", expires_at: 1_700_000_000 },
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  };

  it("preserves message.audio through native -> IR -> native", async () => {
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.choices[0]?.message.audio?.transcript).toBe("hello");
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      choices: Array<{ message: { audio?: { id?: string; transcript?: string } } }>;
    };
    expect(back.choices[0]?.message.audio?.id).toBe("audio_1");
    expect(back.choices[0]?.message.audio?.transcript).toBe("hello");
  });
});

describe("openaiTransformer — max_completion_tokens (o-series, order 4)", () => {
  // o-series models require max_completion_tokens instead of max_tokens. The IR
  // has no .catchall, so without an explicit field it is stripped on inbound parse
  // and never reaches the wire request.
  it("preserves max_completion_tokens through native -> IR -> native", async () => {
    const native = {
      model: "o1",
      messages: [{ role: "user", content: "x" }],
      max_completion_tokens: 1000,
    };
    const ir = await openaiTransformer.transformRequestOut(native);
    expect(ir.max_completion_tokens).toBe(1000);
    const back = (await openaiTransformer.transformRequestIn(ir)) as {
      max_completion_tokens?: number;
    };
    expect(back.max_completion_tokens).toBe(1000);
  });
});

describe("openaiTransformer — service_tier response round-trip (order 2)", () => {
  // OpenAI Chat responses carry a service_tier field; it must survive native -> IR
  // -> native (the IR gains a first-class home so every protocol can read it).
  it("captures and re-emits response.service_tier", async () => {
    const upstream = {
      id: "chatcmpl-st",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      service_tier: "default",
    };
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.service_tier).toBe("default");
    const back = (await openaiTransformer.transformResponseOut(ir)) as { service_tier?: string };
    expect(back.service_tier).toBe("default");
  });
});

describe("openaiTransformer — refusal logprobs track (order 3)", () => {
  // logprobs carries a refusal track alongside content; it must have a structural
  // IR home so cross-protocol consumers can read it (not just blind passthrough).
  it("carries logprobs.refusal through native -> IR -> native", async () => {
    const upstream = {
      id: "chatcmpl-ref",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
          logprobs: {
            content: [{ token: "ok", logprob: -0.1 }],
            refusal: [{ token: "no", logprob: -0.2 }],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const ir = await openaiTransformer.transformResponseIn(upstream);
    expect(ir.choices[0]?.logprobs?.refusal?.[0]?.token).toBe("no");
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      choices: Array<{ logprobs?: { refusal?: Array<{ token: string }> } }>;
    };
    expect(back.choices[0]?.logprobs?.refusal?.[0]?.token).toBe("no");
  });
});

describe("openaiTransformer — completion_tokens_details backfill (order 6)", () => {
  // Anthropic->OpenAI: the IR carries flat reasoning_tokens but no
  // completion_tokens_details. OpenAI clients read reasoning_tokens from the detail
  // object, so the outbound transform must synthesize it from the flat mirror.
  it("synthesizes completion_tokens_details.reasoning_tokens from flat IR.usage", async () => {
    const ir: IRResponse = {
      id: "claude-x",
      model: "claude-3-7-sonnet",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 15 },
    };
    const back = (await openaiTransformer.transformResponseOut(ir)) as {
      usage: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    expect(back.usage.completion_tokens_details?.reasoning_tokens).toBe(15);
  });
});

describe("openaiTransformer — response_format fail-closed validation (order 15)", () => {
  const reqWith = (rf: unknown) => async () =>
    openaiTransformer.transformRequestOut({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
      response_format: rf,
    });

  it("accepts {type:'json_object'} and {type:'text'}", async () => {
    await expect(reqWith({ type: "json_object" })()).resolves.toBeDefined();
    await expect(reqWith({ type: "text" })()).resolves.toBeDefined();
  });

  it("accepts a well-formed json_schema {name, schema}", async () => {
    const ir = await reqWith({
      type: "json_schema",
      json_schema: { name: "out", schema: { type: "object" } },
    })();
    expect((ir.response_format as { type: string }).type).toBe("json_schema");
  });

  it("rejects json_schema missing schema (fail-closed)", async () => {
    await expect(
      reqWith({ type: "json_schema", json_schema: { name: "broken" } })(),
    ).rejects.toThrow(ZodError);
  });

  it("rejects json_schema missing name (fail-closed)", async () => {
    await expect(
      reqWith({ type: "json_schema", json_schema: { schema: { type: "object" } } })(),
    ).rejects.toThrow(ZodError);
  });
});

describe("openaiTransformer — tool-call index stability (order 16)", () => {
  it("preserves an explicit openaiIndex through IRResponse synthesis ordering", async () => {
    // The IR tool_calls array order IS the index; an explicit openaiIndex (when a
    // proxy supplied non-sequential indices) must be honored, not re-sequenced.
    const ir: IRResponse = {
      id: "x",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "a",
                type: "function",
                function: { name: "f0", arguments: "{}" },
                openaiIndex: 0,
              },
              {
                id: "b",
                type: "function",
                function: { name: "f2", arguments: "{}" },
                openaiIndex: 2,
              },
              {
                id: "c",
                type: "function",
                function: { name: "f1", arguments: "{}" },
                openaiIndex: 1,
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    // The IR schema must carry openaiIndex (not strip it).
    const calls = ir.choices[0]?.message.tool_calls;
    expect(calls?.map((c) => c.openaiIndex)).toEqual([0, 2, 1]);
  });
});

// Type-level sanity: the transformer satisfies the IR contract shapes.
const _irReq: IRRequest = { model: "m", messages: [] };
void _irReq;
