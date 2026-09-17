import { describe, expect, test } from "vitest";
import { createGenericOpenAIResponsesClient } from "./openai-responses.js";

// Default-skipped: each run makes real (cheap, non-write) calls to api.deepseek.com.
// Run intentionally with:
//   DEEPSEEK_API_KEY=... HELM_LIVE_DEEPSEEK=1 \
//     CI=true pnpm exec vitest run packages/core/src/provider/live-deepseek-responses.test.ts
//
// This is the REAL-boundary check behind the `deepseek-responses` provider: the unit
// tests pin our request shaping, but only the live endpoint proves the two claims the
// design rests on — (1) it accepts a verbatim Codex body INCLUDING echoed reasoning +
// custom_tool_call, and (2) it 400s on an echoed built-in search call unless we drop it.
const liveEnabled = process.env.HELM_LIVE_DEEPSEEK === "1";

function client(dropSearchItems: boolean) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("missing_DEEPSEEK_API_KEY");
  return createGenericOpenAIResponsesClient({
    config: { baseUrl: "https://api.deepseek.com/v1", apiKey },
    ...(dropSearchItems
      ? { requestContract: { dropBuiltInSearchCallItems: true, acceptsResponsesNativeItems: true } }
      : {}),
  });
}

function translatingClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("missing_DEEPSEEK_API_KEY");
  return createGenericOpenAIResponsesClient({
    config: { baseUrl: "https://api.deepseek.com/v1", apiKey },
    requestContract: {
      dropBuiltInSearchCallItems: true,
      translateUnsupportedCustomTools: true,
      acceptsResponsesNativeItems: true,
    },
  });
}

/**
 * The upstream's own error message. `UpstreamError.message` is the generic
 * "upstream returned 400" — the provider's text lives in `providerRaw`, so a test
 * that wants to prove WHICH rejection fired has to read it from there.
 */
async function upstreamMessage(call: () => Promise<unknown> | undefined): Promise<string> {
  try {
    await call();
  } catch (error) {
    const raw: unknown = (error as { providerRaw?: unknown }).providerRaw;
    return JSON.stringify(raw ?? (error as Error).message);
  }
  throw new Error("expected the call to reject");
}

const CODEX_BODY = {
  model: "deepseek-flash",
  instructions: "You are Codex.",
  store: false,
  tools: [
    { type: "custom", name: "apply_patch", description: "patch" },
    {
      type: "function",
      name: "calc",
      description: "calc",
      strict: true,
      parameters: {
        type: "object",
        properties: { e: { type: "string" } },
        required: ["e"],
        additionalProperties: false,
      },
    },
  ],
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "say done" }] },
    {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "foreign-provider-blob",
      content: [{ type: "reasoning_text", text: "patch then answer" }],
    },
    { type: "custom_tool_call", id: "ctc_1", call_id: "call_9", name: "apply_patch", input: "x" },
    { type: "custom_tool_call_output", call_id: "call_9", output: "ok" },
  ],
};

describe.skipIf(!liveEnabled)("live DeepSeek Responses passthrough", () => {
  test("accepts a verbatim Codex body (reasoning echo-back + custom_tool_call)", async () => {
    const res = (await client(true).nativePassthrough?.(structuredClone(CODEX_BODY))) as Record<
      string,
      unknown
    >;

    expect(res.object).toBe("response");
    expect(res.status).toBe("completed");
  });

  test("400s on a dropped reasoning history — the reason translation must never be used", async () => {
    // Same body minus the reasoning item: this is exactly what the Responses->IR->
    // Responses translate path produces, and DeepSeek rejects it. Proves the
    // xAI-style downgrade-to-translate would break this provider.
    const withoutReasoning = {
      ...structuredClone(CODEX_BODY),
      input: CODEX_BODY.input.filter((item) => item.type !== "reasoning"),
    };

    await expect(
      upstreamMessage(() => client(true).nativePassthrough?.(withoutReasoning)),
    ).resolves.toMatch(/reasoning_text/i);
  });

  test("drops an echoed built-in search call that would otherwise 400", async () => {
    const withSearchCall = {
      ...structuredClone(CODEX_BODY),
      input: [...CODEX_BODY.input, { type: "web_search_call", id: "ws_1", status: "completed" }],
    };

    // With the contract ON the item is stripped and the call succeeds …
    const res = (await client(true).nativePassthrough?.(withSearchCall)) as Record<string, unknown>;
    expect(res.status).toBe("completed");

    // … and without it, the live endpoint really does reject the request.
    await expect(
      upstreamMessage(() => client(false).nativePassthrough?.(structuredClone(withSearchCall))),
    ).resolves.toMatch(/deserialize|queries|action/i);
  });

  // DeepSeek's own Codex guide declares `apply_patch_tool_type: "freeform"` for both
  // models, i.e. Codex is expected to send apply_patch as a freeform CUSTOM tool.
  // That is exactly the tool our translation deliberately leaves alone, so pin the
  // round trip: translating it would have broken the one custom tool that works.
  // https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/
  test("keeps apply_patch as a freeform custom tool round trip", async () => {
    const res = (await translatingClient().nativePassthrough?.({
      model: "deepseek-flash",
      instructions: "You are Codex. Use `apply_patch` for local file edits.",
      store: false,
      tools: [
        { type: "custom", name: "apply_patch", description: "Use `apply_patch` to edit files." },
      ],
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "在 /tmp/demo.txt 里把 foo 改成 bar，用 apply_patch。文件内容就是一行 foo。",
            },
          ],
        },
      ],
    })) as { output: Record<string, unknown>[] };

    const call = res.output.find((item) => item.type === "custom_tool_call");
    expect(call?.name).toBe("apply_patch");
    // The freeform input is a patch envelope, NOT a JSON arguments object.
    expect(String(call?.input)).toContain("*** Begin Patch");
  });

  // `reasoning.summary` is the one knob DeepSeek rejects outright: the documented
  // default is "none", but that literal is not an accepted request value (only
  // auto/concise/detailed are). Worth pinning — a client that echoes the documented
  // default back would get a deterministic 400.
  test("400s on reasoning.summary:none despite it being the documented default", async () => {
    await expect(
      upstreamMessage(() =>
        client(true).nativePassthrough?.({
          model: "deepseek-flash",
          input: "say ok",
          store: false,
          reasoning: { effort: "high", summary: "none" },
        }),
      ),
    ).resolves.toMatch(/unknown variant `none`/i);
  });

  // The DSML-leak regression. A `custom` tool not named `apply_patch` is a hard 400
  // here, so a Codex code-mode transcript (custom tool `exec`) can only be served by
  // translating the declaration AND the replayed calls; left inconsistent, the model
  // abandons the tool protocol and prints its private DSML markers as output_text.
  const CODE_MODE_EXEC_TOOL = {
    type: "custom",
    name: "exec",
    description: "Run JavaScript. Call tools like `await tools.exec_command({cmd, workdir})`.",
  };
  const CODE_MODE_BODY = {
    model: "deepseek-flash",
    instructions: "You are Codex, based on GPT-5.",
    store: false,
    tools: [CODE_MODE_EXEC_TOOL],
    input: [
      {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_1",
        name: "exec",
        input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);\n',
      },
      { type: "custom_tool_call_output", call_id: "call_1", output: "/tmp" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Now list the files with ls -la." }],
      },
    ],
  };

  test("rejects an untranslated code-mode custom tool (the reason translation exists)", async () => {
    await expect(
      upstreamMessage(() => client(true).nativePassthrough?.(CODE_MODE_BODY)),
    ).resolves.toMatch(/Unsupported custom tool/i);
  });

  test("answers a code-mode transcript in the custom_tool_call protocol, no DSML leak", async () => {
    const res = (await translatingClient().nativePassthrough?.(
      structuredClone(CODE_MODE_BODY),
    )) as { status: string; output: Record<string, unknown>[] };

    expect(res.status).toBe("completed");
    // The tool call must come back as a custom_tool_call item …
    const call = res.output.find((item) => item.type === "custom_tool_call");
    expect(call).toBeDefined();
    expect(call?.name).toBe("exec");
    expect(typeof call?.input).toBe("string");
    // … and NOT as DeepSeek's private markers rendered into assistant text.
    const text = JSON.stringify(res.output);
    expect(text).not.toContain("DSML");
    expect(text).not.toContain("｜");
  });

  test("streams a code-mode transcript as custom_tool_call frames", async () => {
    const frames: string[] = [];
    const stream = translatingClient().nativePassthroughStream?.({
      ...structuredClone(CODE_MODE_BODY),
      stream: true,
    });
    if (stream === undefined) throw new Error("stream_unavailable");
    for await (const frame of stream) frames.push(frame);

    const joined = frames.join("");
    expect(joined).toContain("response.custom_tool_call_input.done");
    expect(joined).not.toContain("response.function_call_arguments");
    expect(joined).not.toContain("DSML");
  });

  // The REAL production shape, captured from a leaking request (box request
  // 0e2ad9d9): a Codex code-mode client declares NOTHING in the top-level `tools`
  // field — its tools live inside an `additional_tools` input item, grouped under
  // `namespace` entries, and the custom `exec` even carries a lark grammar in
  // `format`. DeepSeek ignores that item wholesale, so before the hoist the model
  // saw 36 replayed calls to a tool it had never been shown. This is the case the
  // first fix MISSED: it only scanned top-level `tools`, so it was a silent no-op
  // in production while every synthetic test passed.
  const CODE_MODE_ADDITIONAL_TOOLS_BODY = {
    model: "deepseek-flash",
    instructions: "You are Codex, based on GPT-5.",
    store: false,
    // NOTE: no top-level `tools` key at all — exactly as captured.
    input: [
      {
        type: "additional_tools",
        id: "at_1",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "",
            tools: [
              {
                type: "custom",
                name: "exec",
                description: "Run JavaScript to orchestrate tool calls via `await tools.x(...)`.",
                format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
              },
              // A real sibling tool: DeepSeek validates every hoisted schema, so
              // `parameters` must be a proper JSON Schema object (`{}` is a 400).
              {
                type: "function",
                name: "wait",
                description: "Wait.",
                parameters: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          },
          {
            type: "namespace",
            name: "clock",
            tools: [
              {
                type: "function",
                name: "sleep",
                description: "Sleep.",
                parameters: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          },
        ],
      },
      {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_1",
        name: "exec",
        input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);\n',
      },
      { type: "custom_tool_call_output", call_id: "call_1", output: "/tmp" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Now list the files with ls -la." }],
      },
    ],
  };

  test("serves a code-mode body whose tools live in additional_tools, no DSML leak", async () => {
    const res = (await translatingClient().nativePassthrough?.(
      structuredClone(CODE_MODE_ADDITIONAL_TOOLS_BODY),
    )) as { status: string; output: Record<string, unknown>[] };

    expect(res.status).toBe("completed");
    const call = res.output.find((item) => item.type === "custom_tool_call");
    expect(call?.name).toBe("exec");
    const text = JSON.stringify(res.output);
    expect(text).not.toContain("DSML");
    expect(text).not.toContain("｜");
  });

  test("streams native SSE frames verbatim", async () => {
    const frames: string[] = [];
    const stream = client(true).nativePassthroughStream?.({
      model: "deepseek-flash",
      input: "hi",
      stream: true,
    });
    if (stream === undefined) throw new Error("stream_unavailable");
    for await (const frame of stream) frames.push(frame);

    const joined = frames.join("");
    expect(joined).toContain("response.created");
    expect(joined).toContain("response.completed");
    // DeepSeek's Responses SSE has no [DONE] sentinel (unlike Chat Completions).
    expect(joined).not.toContain("[DONE]");
  });
});
