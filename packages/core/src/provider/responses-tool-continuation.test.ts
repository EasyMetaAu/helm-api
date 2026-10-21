import type { ResponsesToolTranslation } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createGenericOpenAIResponsesClient } from "./openai-responses.js";

const tool = { type: "custom", name: "exec", format: { type: "text" } };
const call = (id: string) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: id,
  name: "exec",
  arguments: '{"input":"true"}',
});
function fixture(stream: boolean, id: string) {
  const sent: Record<string, unknown>[] = [];
  const client = createGenericOpenAIResponsesClient({
    config: { baseUrl: "https://deepseek.test/v1", apiKey: "synthetic" },
    requestContract: {
      translateUnsupportedCustomTools: true,
      dropUnpairedFunctionCallOutputs: true,
    },
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      const response = { id, object: "response", status: "completed", output: [call(id)] };
      if (!stream) return Response.json(response);
      return new Response(
        [
          { type: "response.created", response: { id, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: call(id) },
          { type: "response.output_item.done", output_index: 0, item: call(id) },
          { type: "response.completed", response },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { client, sent };
}

describe("DeepSeek custom tool continuation", () => {
  it.each([
    false,
    true,
  ])("restores tool types across three turns and fresh clients (stream=%s)", async (stream) => {
    let previous: ResponsesToolTranslation | undefined;
    for (let turn = 0; turn < 3; turn++) {
      const { client, sent } = fixture(stream, `r${turn}`);
      let state: ResponsesToolTranslation | undefined;
      const body =
        turn === 0
          ? { model: "deepseek-flash", tools: [tool], input: [{ role: "user", content: "test" }] }
          : {
              model: "deepseek-flash",
              previous_response_id: `r${turn - 1}`,
              input: [{ type: "custom_tool_call_output", call_id: `r${turn - 1}`, output: "ok" }],
            };
      const opts = {
        previousToolTranslation: previous,
        onToolTranslation: (value: ResponsesToolTranslation) => {
          state = value;
        },
      };
      let output: unknown;
      if (stream) {
        let wire = "";
        const frames = client.nativePassthroughStream?.(body, opts);
        if (!frames) throw new Error("native Responses stream unavailable");
        for await (const chunk of frames) wire += chunk;
        const events = wire
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        output = events.find((event) => event.type === "response.completed").response;
        expect(events.find((event) => event.type === "response.output_item.done").item.type).toBe(
          "custom_tool_call",
        );
      } else output = await client.nativePassthrough?.(body, opts);
      if (turn > 0)
        expect(sent[0]?.input).toMatchObject([
          { type: "function_call_output", call_id: `r${turn - 1}` },
        ]);
      expect(output).toMatchObject({ output: [{ type: "custom_tool_call", call_id: `r${turn}` }] });
      expect(state).toEqual({ toolNames: ["exec"], pendingCallIds: [`r${turn}`] });
      previous = JSON.parse(JSON.stringify(state));
    }
  });

  it("isolates sibling branches and preserves native custom results", async () => {
    const previous = { toolNames: ["exec"], pendingCallIds: ["a", "b"] };
    const states = await Promise.all(
      ["a", "b"].map(async (id) => {
        const { client, sent } = fixture(false, `new_${id}`);
        let state: ResponsesToolTranslation | undefined;
        await client.nativePassthrough?.(
          {
            model: "deepseek-flash",
            previous_response_id: "parent",
            input: [
              {
                type: "custom_tool_call_output",
                call_id: id,
                output: [{ type: "input_text", text: "ok" }],
              },
              { type: "custom_tool_call_output", call_id: "native_apply_patch", output: "native" },
            ],
          },
          {
            previousToolTranslation: previous,
            onToolTranslation: (value) => {
              state = value;
            },
          },
        );
        expect(sent[0]?.input).toEqual([
          {
            type: "function_call_output",
            call_id: id,
            output: [{ type: "input_text", text: "ok" }],
          },
          { type: "custom_tool_call_output", call_id: "native_apply_patch", output: "native" },
        ]);
        return state;
      }),
    );
    expect(previous).toEqual({ toolNames: ["exec"], pendingCallIds: ["a", "b"] });
    expect(states).toEqual([
      { toolNames: ["exec"], pendingCallIds: ["b", "new_a"] },
      { toolNames: ["exec"], pendingCallIds: ["a", "new_b"] },
    ]);
  });

  it("refuses an orphaned legacy continuation before sending or dropping its tool result", async () => {
    const { client, sent } = fixture(false, "r");
    await expect(
      client.nativePassthrough?.({
        model: "deepseek-flash",
        previous_response_id: "legacy",
        input: [{ type: "custom_tool_call_output", call_id: "call", output: "real result" }],
      }),
    ).rejects.toThrow(/full conversation input/);
    expect(sent).toEqual([]);
  });
});
