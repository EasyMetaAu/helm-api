import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { estimateRequestTokens } from "./server.js";

// A minimal Hono context whose request carries the given content-length header.
// We never read the body here — the estimator must derive its estimate WITHOUT
// consuming the stream, so the downstream route can still parse the body.
async function ctxWithContentLength(
  len: string | null,
): Promise<Parameters<Parameters<Hono["use"]>[1]>[0]> {
  const app = new Hono();
  let captured: unknown;
  app.use("*", async (c, next) => {
    captured = c;
    await next();
  });
  app.get("/", (c) => c.text("ok"));
  const headers: Record<string, string> = {};
  if (len !== null) headers["content-length"] = len;
  await app.request("/", { headers });
  // biome-ignore lint/suspicious/noExplicitAny: test narrows the captured context
  return captured as any;
}

describe("estimateRequestTokens", () => {
  it("derives a deterministic estimate of ceil(content-length / 4)", async () => {
    const c = await ctxWithContentLength("400");
    expect(estimateRequestTokens(c)).toBe(100);
  });

  it("rounds up partial tokens (ceil, not floor)", async () => {
    const c = await ctxWithContentLength("401");
    expect(estimateRequestTokens(c)).toBe(101);
  });

  it("estimates 0 when no content-length is present (cannot size the body)", async () => {
    const c = await ctxWithContentLength(null);
    expect(estimateRequestTokens(c)).toBe(0);
  });

  it("estimates 0 for a non-numeric / malformed content-length (never NaN)", async () => {
    const c = await ctxWithContentLength("not-a-number");
    expect(estimateRequestTokens(c)).toBe(0);
  });

  it("estimates 0 for a negative content-length (clamped, never negative)", async () => {
    const c = await ctxWithContentLength("-100");
    expect(estimateRequestTokens(c)).toBe(0);
  });
});
