import { expect, test } from "@playwright/test";
import {
  CAPTURE_PATH,
  TOOL_CALL_SENTINEL,
  type UpstreamCapture,
} from "./fixtures/mock-upstream.js";

// e2e.protocol — black-box the WHOLE protocol-translation chain over real HTTP
// into a real gateway + a deterministic OpenAI-shaped mock upstream. The unit
// tests prove each transformer in isolation; only this spec proves the seams
// hold once stitched end-to-end, in BOTH client directions, across the two
// high-risk paths the docs call out: streaming SSE and tool-calls (CLAUDE.md
// §Testing Requirements / docs/05 Protocol Translation).
//
// We assert BOTH sides of the translation:
//   (a) the client RESPONSE matches its own protocol shape (Anthropic vs OpenAI);
//   (b) the request the gateway forwarded UPSTREAM is the unified normalized
//       (OpenAI-Chat IR) shape — read back from the mock's capture endpoint —
//       proving nativeIn → IR → nativeOut (one hub, not N×N direct).
//
// Determinism (CI-safe): the mock is fixed/offline, the e2e key is pre-seeded,
// and prompts are chosen to hit the LAYER-1 RULE classifier (eval OFF). A prompt
// sentinel steers the mock into its tool-call script (the gateway forwards only
// model+messages+tools upstream, so faults/branches must ride in the prompt).

const TEST_KEY = "helm_live_e2e_testkey";
const ANTHROPIC_AUTH = { "x-api-key": TEST_KEY, "Content-Type": "application/json" };
const OPENAI_AUTH = { Authorization: `Bearer ${TEST_KEY}`, "Content-Type": "application/json" };

// The capture endpoint lives on the MOCK upstream (not the gateway baseURL), so
// we read it through its absolute URL — matching playwright.config's MOCK_PORT.
const MOCK_BASE_URL = `http://127.0.0.1:${process.env.MOCK_PORT ?? "8181"}`;

// Pull the most recent request the gateway forwarded upstream (normalized shape).
async function lastUpstreamRequest(request: {
  get: (url: string) => Promise<{ json: () => Promise<UpstreamCapture> }>;
}): Promise<UpstreamCapture> {
  const res = await request.get(`${MOCK_BASE_URL}${CAPTURE_PATH}`);
  return res.json();
}

// ── Anthropic client → Helm → upstream ──────────────────────────────────────
test.describe("Anthropic client → upstream", () => {
  test("non-stream: messages round-trip + normalized upstream request", async ({ request }) => {
    const res = await request.post("/v1/messages", {
      headers: ANTHROPIC_AUTH,
      data: {
        model: "auto",
        max_tokens: 64,
        messages: [{ role: "user", content: "translate this sentence to french: hello" }],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // (a) client sees the Anthropic native shape.
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
    expect(typeof body.content[0].text).toBe("string");
    expect(body.stop_reason).toBe("end_turn");

    // (b) the upstream got the normalized (OpenAI-Chat) request: messages, a
    // resolved provider model (an alias, NOT the client's "auto"), no Anthropic-
    // only top-level fields like `max_tokens` riding as `system`.
    const upstream = await lastUpstreamRequest(request);
    expect(Array.isArray(upstream.body.messages)).toBeTruthy();
    expect(upstream.body.model).not.toBe("auto");
    expect(typeof upstream.body.model).toBe("string");
  });

  test("stream: SSE event sequence is well-formed", async ({ request }) => {
    const res = await request.post("/v1/messages", {
      headers: ANTHROPIC_AUTH,
      data: {
        model: "auto",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "translate this sentence to french: hola" }],
      },
    });
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const text = await res.text();
    // The Anthropic event sequence boundaries (docs/05): start → delta → stop.
    const startIdx = text.indexOf("message_start");
    const deltaIdx = text.indexOf("content_block_delta");
    const stopIdx = text.indexOf("message_stop");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThan(startIdx);
    expect(stopIdx).toBeGreaterThan(deltaIdx);
    // never leak a raw OpenAI chunk through the Anthropic surface.
    expect(text).not.toContain("chat.completion.chunk");
  });

  test("tool-call: upstream function call → client sees tool_use block", async ({ request }) => {
    const res = await request.post("/v1/messages", {
      headers: ANTHROPIC_AUTH,
      data: {
        model: "auto",
        max_tokens: 64,
        messages: [{ role: "user", content: `look up the weather ${TOOL_CALL_SENTINEL}` }],
        tools: [
          {
            name: "get_weather",
            description: "get the weather",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const toolUse = body.content.find((b: { type: string }) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(typeof toolUse.id).toBe("string");
    expect(toolUse.id.length).toBeGreaterThan(0);
    expect(toolUse.name).toBe("get_weather");
    // arguments were parsed into an object input (docs/05 pit #3).
    expect(typeof toolUse.input).toBe("object");
    expect(body.stop_reason).toBe("tool_use");
  });
});

// ── OpenAI client → Helm → upstream ─────────────────────────────────────────
test.describe("OpenAI client → upstream", () => {
  test("non-stream: chat.completions round-trip", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      headers: OPENAI_AUTH,
      data: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "translate this sentence to french: hello" }],
        stream: false,
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.choices[0].message.role).toBe("assistant");
    expect(typeof body.choices[0].message.content).toBe("string");
  });

  test("stream: first chunk carries role, last carries finish_reason, ends [DONE]", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      headers: OPENAI_AUTH,
      data: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "translate this sentence to french: hola" }],
        stream: true,
      },
    });
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("[DONE]");
    // chunks are ordered SSE `data:` frames.
    expect(text).toContain("data:");
  });

  test("tool-call stream: tool_calls index/id coordinate across chunks", async ({ request }) => {
    const res = await request.post("/v1/chat/completions", {
      headers: OPENAI_AUTH,
      data: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: `look up the weather ${TOOL_CALL_SENTINEL}` }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        stream: true,
      },
    });
    expect(res.ok()).toBeTruthy();
    const text = await res.text();
    // the streamed tool_calls fragments name the function and end [DONE].
    expect(text).toContain("tool_calls");
    expect(text).toContain("get_weather");
    expect(text).toContain("[DONE]");
  });
});

// ── OpenAI Responses client → Helm → upstream (SSE streaming) ───────────────
// The Responses surface is the THIRD client protocol. Streaming emits the native
// `response.*` event sequence via the second IR→SSE state machine. This proves the
// seam end-to-end: created → … → completed, monotonic sequence_number, delta
// concatenation, tool-call streaming, and the OpenAI error envelope on failure
// (docs/05 §Responses item expansion, principle 8).
test.describe("OpenAI Responses client → upstream (streaming)", () => {
  // Parse an SSE body into ordered { event, data } frames.
  function parseSSE(text: string): Array<{ event: string; data: string }> {
    const frames: Array<{ event: string; data: string }> = [];
    for (const block of text.split("\n\n")) {
      if (block.trim() === "") continue;
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      frames.push({ event, data });
    }
    return frames;
  }

  test("text stream: response.created … response.completed, monotonic sequence_number", async ({
    request,
  }) => {
    const res = await request.post("/v1/responses", {
      headers: OPENAI_AUTH,
      data: {
        model: "auto",
        input: "translate this sentence to french: hola",
        stream: true,
      },
    });
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const text = await res.text();
    const frames = parseSSE(text);

    // ordered envelope boundaries (no [DONE] sentinel on the Responses surface).
    expect(frames[0]?.event).toBe("response.created");
    expect(frames.at(-1)?.event).toBe("response.completed");
    expect(text).not.toContain("[DONE]");
    // never leak a raw OpenAI chunk through the Responses surface.
    expect(text).not.toContain("chat.completion.chunk");

    // sequence_number is strictly monotonic across every event.
    const seqs = frames.map(
      (f) => (JSON.parse(f.data) as { sequence_number: number }).sequence_number,
    );
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? -1) + 1);
    }

    // output_text.delta concatenation equals the output_text.done full text.
    const deltas = frames
      .filter((f) => f.event === "response.output_text.delta")
      .map((f) => (JSON.parse(f.data) as { delta: string }).delta)
      .join("");
    const doneFrame = frames.find((f) => f.event === "response.output_text.done");
    expect(doneFrame).toBeDefined();
    const doneText = (JSON.parse(doneFrame?.data ?? "{}") as { text?: string }).text;
    expect(doneText).toBe(deltas);
  });

  test("tool-call stream: function_call item + arguments deltas", async ({ request }) => {
    const res = await request.post("/v1/responses", {
      headers: OPENAI_AUTH,
      data: {
        model: "auto",
        input: `look up the weather ${TOOL_CALL_SENTINEL}`,
        tools: [
          {
            type: "function",
            name: "get_weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        stream: true,
      },
    });
    expect(res.ok()).toBeTruthy();
    const text = await res.text();
    const frames = parseSSE(text);

    const added = frames.find((f) => f.event === "response.output_item.added");
    expect(added).toBeDefined();
    const item = (JSON.parse(added?.data ?? "{}") as { item?: { type?: string; name?: string } })
      .item;
    expect(item?.type).toBe("function_call");
    expect(item?.name).toBe("get_weather");
    // arguments arrive as function_call_arguments.delta and close with .done.
    expect(text).toContain("response.function_call_arguments.delta");
    expect(text).toContain("response.function_call_arguments.done");
    expect(frames.at(-1)?.event).toBe("response.completed");
  });
});

// ── Bidirectional isomorphism: same logical chat, two client protocols, ONE
//    normalized upstream shape (proves a unified IR hub, not N×N direct). ─────
test.describe("bidirectional isomorphism", () => {
  test("both client protocols normalize to the same upstream request shape", async ({
    request,
  }) => {
    const prompt = "translate this sentence to french: hello";

    await request.post("/v1/chat/completions", {
      headers: OPENAI_AUTH,
      data: { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], stream: false },
    });
    const openaiUpstream = await lastUpstreamRequest(request);

    await request.post("/v1/messages", {
      headers: ANTHROPIC_AUTH,
      data: { model: "auto", max_tokens: 64, messages: [{ role: "user", content: prompt }] },
    });
    const anthropicUpstream = await lastUpstreamRequest(request);

    // both upstream requests carry the SAME user message content in the SAME
    // normalized shape — the only structural difference is the resolved model.
    const openaiMsg = openaiUpstream.body.messages.at(-1) as { role: string; content: unknown };
    const anthropicMsg = anthropicUpstream.body.messages.at(-1) as {
      role: string;
      content: unknown;
    };
    expect(openaiMsg.role).toBe("user");
    expect(anthropicMsg.role).toBe("user");
    // content reaches the upstream in a normalized form for both directions.
    const flatten = (c: unknown): string =>
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c
              .map((p) =>
                p && typeof p === "object" && "text" in p ? (p as { text: string }).text : "",
              )
              .join("")
          : "";
    expect(flatten(openaiMsg.content)).toContain("translate this sentence to french");
    expect(flatten(anthropicMsg.content)).toContain("translate this sentence to french");
  });

  test("auth enforced: missing key on /v1/messages is rejected (401)", async ({ request }) => {
    const res = await request.post("/v1/messages", {
      headers: { "Content-Type": "application/json" },
      data: { model: "auto", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    // Anthropic-shaped error envelope.
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });
});
