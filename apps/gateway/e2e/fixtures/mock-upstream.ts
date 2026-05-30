import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

// A local stand-in for an OpenAI-compatible upstream. Deterministic, offline.
//
// Behaviour (all CI-reproducible — no network, no clock dependence):
//  • Non-stream: returns a fixed chat.completion JSON, but ECHOES the request's
//    `model` back as `model` so the gateway's resolved provider model is
//    observable end-to-end (routing-signal assertion).
//  • Stream: returns text/event-stream with delta chunks + [DONE].
//  • Error injection: the gateway only forwards `model` + `messages` (+ a few
//    standard fields) to the upstream — NOT arbitrary client headers. So the
//    fault is steered through the PROMPT: when a message contains the sentinel
//    `FAIL_PRIMARY_SENTINEL`, the mock returns 5xx for `FAIL_PRIMARY_MODEL`
//    (the economy lane head, the request's PRIMARY candidate) and serves every
//    other model normally. The gateway then retries the next in-chain candidate
//    (a different model) → EXECUTION fallback, deterministic and self-contained.

// Base body shape. `model` is overwritten per-request with the echoed model.
const BASE_RESPONSE = {
  id: "chatcmpl-mock",
  object: "chat.completion",
  model: "mock-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" },
  ],
};

// Backwards-compatible export: the canonical non-stream body for a request whose
// model is the default `mock-model` (used by the smoke passthrough test, which
// sends a model the gateway forwards verbatim under explicit passthrough).
export const NONSTREAM_RESPONSE = BASE_RESPONSE;

// Build the echoed non-stream body for a given model id.
export function echoResponse(model: string) {
  return { ...BASE_RESPONSE, model };
}

// Prompt sentinel + the model it fails. A message carrying the sentinel makes
// the mock 5xx ONLY the economy lane head (the primary candidate), forcing the
// gateway to fall forward to the next in-chain candidate. Exported so the spec
// and the mock stay in lockstep.
export const FAIL_PRIMARY_SENTINEL = "__HELM_FAIL_PRIMARY__";
export const FAIL_PRIMARY_MODEL = "cheap_model";

function messagesText(body: { messages?: unknown }): string {
  if (!Array.isArray(body.messages)) return "";
  let text = "";
  for (const m of body.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") text += content;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") text += part;
        else if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          text += (part as { text: string }).text;
        }
      }
    }
  }
  return text;
}

export const STREAM_CHUNKS = [
  'data: {"id":"chatcmpl-mock","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"id":"chatcmpl-mock","choices":[{"delta":{"content":"hel"}}]}\n\n',
  'data: {"id":"chatcmpl-mock","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

// —— tool-call scripts (e2e.protocol) ————————————————————————————————————————
// A prompt carrying TOOL_CALL_SENTINEL makes the mock answer with an OpenAI
// function tool_call instead of plain text — exercising the tool-call branch of
// both protocol directions. The stream variant FRAGMENTS the arguments across
// chunks and supplies the id/name only on the FIRST fragment, so the gateway's
// streaming state machine (docs/05 pit #3) has to coordinate index/id and
// accumulate partial JSON. Kept here so the spec and the mock stay in lockstep.
export const TOOL_CALL_SENTINEL = "__HELM_TOOL_CALL__";
const TOOL_CALL_ID = "call_mock_weather";
const TOOL_CALL_NAME = "get_weather";

// Non-stream OpenAI tool_call completion.
function toolCallResponse(model: string) {
  return {
    id: "chatcmpl-mock-tool",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: TOOL_CALL_ID,
              type: "function",
              function: { name: TOOL_CALL_NAME, arguments: '{"city":"Paris"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

// Streamed OpenAI tool_call chunks: id+name on the FIRST fragment, then the JSON
// arguments split across two fragments, then finish_reason + [DONE].
export const TOOL_CALL_STREAM_CHUNKS = [
  'data: {"id":"chatcmpl-mock-tool","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  `data: {"id":"chatcmpl-mock-tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"${TOOL_CALL_ID}","type":"function","function":{"name":"${TOOL_CALL_NAME}","arguments":"{\\"city\\":"}}]}}]}\n\n`,
  'data: {"id":"chatcmpl-mock-tool","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}\n\n',
  'data: {"id":"chatcmpl-mock-tool","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
];

// —— upstream request capture (e2e.protocol) —————————————————————————————————
// The path the spec GETs to read back the LAST request the gateway forwarded
// upstream. Lets the e2e assert the NORMALIZED (OpenAI-Chat IR) request shape
// for BOTH client directions — proving nativeIn → IR → nativeOut.
export const CAPTURE_PATH = "/__captured";

export interface UpstreamCapture {
  body: { model?: string; messages: unknown[]; [k: string]: unknown };
  count: number;
}

export function createMockUpstream() {
  const app = new Hono();
  // The last request the gateway forwarded upstream + a monotonic counter. Lets
  // the e2e read back the NORMALIZED request shape (CAPTURE_PATH).
  let lastCapture: UpstreamCapture = { body: { messages: [] }, count: 0 };

  // Readiness probe for Playwright's webServer wait.
  app.get("/", (c) => c.text("mock upstream ok"));
  // Read back the last normalized upstream request (e2e.protocol assertions).
  app.get(CAPTURE_PATH, (c) => c.json(lastCapture));

  app.post("/chat/completions", async (c) => {
    const body = (await c.req.json()) as {
      stream?: boolean;
      model?: unknown;
      messages?: unknown;
    };
    const model = typeof body.model === "string" ? body.model : "mock-model";
    // Record the normalized request so the e2e can assert nativeIn → IR → nativeOut.
    lastCapture = {
      body: body as UpstreamCapture["body"],
      count: lastCapture.count + 1,
    };

    const promptText = messagesText(body);

    // Error injection (prompt-steered): a sentinel in the prompt fails ONLY the
    // economy head (primary candidate) so the gateway falls forward to the next
    // candidate in the chain (EXECUTION fallback).
    if (promptText.includes(FAIL_PRIMARY_SENTINEL) && model === FAIL_PRIMARY_MODEL) {
      return c.json(
        { error: { message: "mock injected upstream error", type: "server_error" } },
        500,
      );
    }

    // Tool-call branch (prompt-steered): emit an OpenAI function tool_call.
    if (promptText.includes(TOOL_CALL_SENTINEL)) {
      if (body.stream === true) {
        return streamSSE(c, async (sse) => {
          for (const chunk of TOOL_CALL_STREAM_CHUNKS) await sse.write(chunk);
        });
      }
      return c.json(toolCallResponse(model));
    }

    if (body.stream === true) {
      return streamSSE(c, async (sse) => {
        for (const chunk of STREAM_CHUNKS) await sse.write(chunk);
      });
    }
    // Echo the model so the gateway's resolved provider model is observable.
    return c.json(echoResponse(model));
  });
  return app;
}

// Run standalone (used as the e2e mock process). PORT via MOCK_PORT.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT ?? "8181");
  serve({ fetch: createMockUpstream().fetch, port, hostname: "127.0.0.1" });
  // eslint-disable-next-line no-console
  process.stdout.write(`mock upstream listening on ${port}\n`);
}
