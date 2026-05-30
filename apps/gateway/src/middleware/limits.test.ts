import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const LIMITS = { maxBodyBytes: 100, requestTimeoutMs: 50 };

function buildApp() {
  const app = createApp({ logger: { log: () => {} }, limits: LIMITS });
  app.post("/echo", async (c) => c.json(await c.req.json()));
  app.post("/slow", async (c) => {
    await new Promise((r) => setTimeout(r, 200));
    return c.text("done");
  });
  return app;
}

describe("body limit + timeout middleware", () => {
  it("rejects an oversized body via Content-Length with 400 invalid_request", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "5000" },
      body: JSON.stringify({ x: "y" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.trace_id).toBeTruthy();
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

  it("rejects by actual stream bytes even without Content-Length", async () => {
    const app = buildApp();
    const big = "x".repeat(500);
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ big }),
    });
    expect(res.status).toBe(400);
  });

  it("maps a slow handler to 504 timeout", async () => {
    const app = buildApp();
    const res = await app.request("/slow", { method: "POST", body: "{}" });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("timeout");
  });

  it("does not time out a fast handler", async () => {
    const app = createApp({
      logger: { log: () => {} },
      limits: { maxBodyBytes: 1000, requestTimeoutMs: 500 },
    });
    app.get("/fast", (c) => c.text("ok"));
    const res = await app.request("/fast");
    expect(res.status).toBe(200);
  });
});
