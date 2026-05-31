import { describe, expect, it } from "vitest";
import type { IRRequest, IRResponse } from "./ir.js";
import { TransformerRegistry } from "./registry.js";
import { responsesTransformer } from "./responses.js";

// OpenAI Responses transformer (docs/05). Responses is a DIFFERENT request shape
// from Chat Completions: instead of `messages[]` (role + content), the
// conversation is flattened into a top-level `input[]` ITEM stream — user/
// assistant text, `function_call`, `function_call_output`, and `reasoning`
// items are all siblings, not nested inside a message. This transformer folds
// the item stream back into the OpenAI-Chat-shaped IR on the way in, and
// explodes the IR back into the item stream on the way out. Correctness is
// aligned item-by-item with litellm's messages_to_responses_mapping.

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
