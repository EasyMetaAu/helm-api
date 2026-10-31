import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { outboundPrivacyMiddleware } from "./outbound-privacy.js";

const secret = `sk-${"y".repeat(30)}`;
describe("privacy across the HTTP inference boundary", () => {
  it.each([
    "/v1/messages",
    "/v1/responses",
    "/v1/chat/completions",
    "/v1beta/models/m:generateContent",
  ])("masks before handlers and restores the %s JSON response", async (path) => {
    const app = new Hono<AppEnv>();
    const upstream = vi.fn();
    app.use("*", outboundPrivacyMiddleware("mask"));
    app.post(path, async (c) => {
      const body = await c.req.json();
      upstream(body);
      return c.json({ text: body.input });
    });
    const response = await app.request(path, {
      method: "POST",
      body: JSON.stringify({ input: secret }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(upstream.mock.calls)).not.toContain(secret);
    expect(await response.json()).toEqual({ text: secret });
  });
  it("never invokes a handler for unsupported continuation or media paths", async () => {
    const app = new Hono<AppEnv>();
    const upstream = vi.fn();
    app.use("*", outboundPrivacyMiddleware("mask"));
    app.all("*", (c) => {
      upstream();
      return c.json({});
    });
    for (const path of [
      "/v1/responses/compact",
      "/v1/images/generations",
      "/v1/responses/r1",
      "/v1/tts",
      "/v1/3d/generations",
    ]) {
      expect((await app.request(path, { method: "POST", body: "{}" })).status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it("cancels a stalled source before waiting for its generator to finish", async () => {
    const app = new Hono<AppEnv>();
    let cancelled = false;
    app.use("*", outboundPrivacyMiddleware("mask"));
    app.post("/v1/messages", async (c) => {
      await c.req.json();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"safe"}}\n\n',
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const response = await app.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ input: secret }),
    });
    if (!response.body) throw new Error("Missing test response body");
    const reader = response.body.getReader();
    await reader.read();
    const pending = reader.read();
    await reader.cancel();
    await pending;
    expect(cancelled).toBe(true);
  }, 1000);
  it("leaves normal authorization in force", async () => {
    const app = new Hono<AppEnv>();
    const upstream = vi.fn();
    app.use("*", outboundPrivacyMiddleware("mask"));
    app.use("*", async (c) => c.json({ error: "unauthorized" }, 401));
    app.post("/v1/messages", (c) => {
      upstream();
      return c.json({});
    });
    expect(
      (
        await app.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({ input: secret }),
        })
      ).status,
    ).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});
