import { Hono } from "hono";
import { expect, it } from "vitest";
import { helmRelayHeaders, relayClientIdentityMiddleware } from "./relay-client-identity.js";

it("preserves per-request identities at the final relay boundary across concurrent routes and retries", async () => {
  const app = new Hono();
  app.use("*", relayClientIdentityMiddleware());
  app.all("*", async (c) => {
    await new Promise((resolve) => setTimeout(resolve, c.req.path.length));
    const original = { "User-Agent": "provider-default", Authorization: "Bearer upstream-key" };
    const first = helmRelayHeaders(original);
    await Promise.resolve();
    const retry = helmRelayHeaders(first);
    expect(original["User-Agent"]).toBe("provider-default");
    expect(retry.get("authorization")).toBe("Bearer upstream-key");
    return c.json({ first: first.get("user-agent"), retry: retry.get("user-agent") });
  });
  const paths = [
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1beta/models/gemini:generateContent",
    "/v1/images/edits",
    "/v1/videos/task",
    "/v1/audio/transcriptions",
  ];
  await Promise.all(
    paths.map(async (path, index) => {
      const ua =
        index % 2 ? "claude-cli/2.1.319 (external, cli)" : "grok-shell/1.0.77 (macos; aarch64)";
      const response = await app.request(path, { headers: { "user-agent": ua } });
      expect(await response.json()).toEqual({ first: ua, retry: ua });
    }),
  );
  expect(await (await app.request("/v1/models")).json()).toEqual({ first: "", retry: "" });
  expect(helmRelayHeaders({ "User-Agent": "background-agent" }).get("user-agent")).toBe(
    "background-agent",
  );
});
