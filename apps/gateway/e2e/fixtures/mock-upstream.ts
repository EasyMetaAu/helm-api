import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

// A local stand-in for an OpenAI-compatible upstream. Deterministic, offline.
// Non-stream: returns a fixed chat.completion JSON.
// Stream: returns text/event-stream with delta chunks + [DONE].

export const NONSTREAM_RESPONSE = {
  id: "chatcmpl-mock",
  object: "chat.completion",
  model: "mock-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" },
  ],
};

export const STREAM_CHUNKS = [
  'data: {"id":"chatcmpl-mock","choices":[{"delta":{"content":"hel"}}]}\n\n',
  'data: {"id":"chatcmpl-mock","choices":[{"delta":{"content":"lo"}}]}\n\n',
  "data: [DONE]\n\n",
];

export function createMockUpstream() {
  const app = new Hono();
  // Readiness probe for Playwright's webServer wait.
  app.get("/", (c) => c.text("mock upstream ok"));
  app.post("/chat/completions", async (c) => {
    const body = (await c.req.json()) as { stream?: boolean };
    if (body.stream === true) {
      return streamSSE(c, async (sse) => {
        for (const chunk of STREAM_CHUNKS) await sse.write(chunk);
      });
    }
    return c.json(NONSTREAM_RESPONSE);
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
