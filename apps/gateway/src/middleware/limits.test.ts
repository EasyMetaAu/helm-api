import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const LIMITS = { requestTimeoutMs: 50 };

function buildApp() {
  const app = createApp({ logger: { log: () => {} }, limits: LIMITS });
  app.post("/echo", async (c) => c.json(await c.req.json()));
  app.post("/slow", async (c) => {
    await new Promise((r) => setTimeout(r, 200));
    return c.text("done");
  });
  app.get("/stream", (c) => {
    const signal = c.get("request_timeout")?.signal;
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          await new Promise((resolve) => setTimeout(resolve, 100));
          controller.enqueue(new TextEncoder().encode(signal?.aborted ? "aborted" : "late"));
          controller.close();
        },
      }),
    );
  });
  return app;
}

describe("timeout middleware", () => {
  it("does not enforce an application request-body limit", async () => {
    const app = buildApp();
    const payload = { big: "x".repeat(500) };
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it("lets a normal-sized body through", async () => {
    const app = buildApp();
    const payload = { a: 1 };
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it("maps a slow handler to 504 timeout", async () => {
    const app = buildApp();
    const res = await app.request("/slow", { method: "POST", body: "{}" });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("timeout");
  });

  it("keeps timeout signal armed until a streaming body completes", async () => {
    const app = buildApp();
    const res = await app.request("/stream");
    expect(await res.text()).toBe("firstaborted");
  });

  it("cancels the wrapped source body when the client cancels", async () => {
    let cancelled = false;
    const app = createApp({
      logger: { log: () => {} },
      limits: { requestTimeoutMs: 500 },
    });
    app.get(
      "/cancel",
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("chunk"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const res = await app.request("/cancel");
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(cancelled).toBe(true);
  });

  it("does not time out a fast handler", async () => {
    const app = createApp({
      logger: { log: () => {} },
      limits: { requestTimeoutMs: 500 },
    });
    app.get("/fast", (c) => c.text("ok"));
    const res = await app.request("/fast");
    expect(res.status).toBe(200);
  });
});
