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

    await expect(client(true).nativePassthrough?.(withoutReasoning)).rejects.toThrow(
      /reasoning_text/i,
    );
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
      client(false).nativePassthrough?.(structuredClone(withSearchCall)),
    ).rejects.toThrow(/deserialize|queries|action/i);
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
