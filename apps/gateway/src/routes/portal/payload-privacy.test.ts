import { expect, it } from "vitest";
import { projectPortalPayload } from "./payload-privacy.js";

it("fails closed if generated-metadata projection cannot complete", () => {
  const json =
    '{"client_metadata":' +
    '{"nested":'.repeat(10000) +
    '"private-account"' +
    "}".repeat(10000) +
    "}";
  expect(() => projectPortalPayload(json, "upstream_request")).toThrow();
});
it("keeps caller/model content but strips credentials and identity diagnostics in SSE errors", () => {
  const input = JSON.stringify({ messages: [{ role: "user", content: "user@example.com" }] });
  expect(projectPortalPayload(input, "request")).toBe(input);
  const sse =
    'data: {"type":"response.output_text.delta","delta":"user@example.com"}\n\ndata: {"type":"error","error":{"message":"owner@gmail.com","api_key":"PRIVATE_CREDENTIAL","stack":"PRIVATE_STACK"}}\n\ndata: [DONE]\n\n';
  const output = projectPortalPayload(sse, "response");
  expect(output).toContain("user@example.com");
  expect(output).toContain("[DONE]");
  expect(output).not.toMatch(/owner@gmail.com|PRIVATE_CREDENTIAL|PRIVATE_STACK/);
});
it("drops string-encoded Codex turn metadata", () => {
  const json = JSON.stringify({
    client_metadata: {
      "X-Codex-Turn-Metadata": JSON.stringify({ installation_id: "PRIVATE_INSTALLATION" }),
    },
  });
  expect(projectPortalPayload(json, "upstream_request")).not.toContain("PRIVATE_INSTALLATION");
});
it("projects whole multiline SSE error frames and withholds undecodable error data", () => {
  const input =
    'event: error\r\ndata: {"error":\r\ndata: {"message":"owner@gmail.com","stack":"PRIVATE"}}\r\n\r\nevent: error\ndata: broken PRIVATE owner@gmail.com\n\nevent: response.output_text.delta\ndata: {"delta":"user@example.com"}\n\n';
  const output = projectPortalPayload(input, "response");
  expect(output).not.toMatch(/owner@gmail.com|PRIVATE/);
  expect(output).toContain("user@example.com");
});

it("allow-lists forwarded top-level fields without exposing cross-tenant account markers", () => {
  const input = JSON.stringify({
    model: "model",
    input: "user@example.com",
    stream: true,
    tools: [],
    temperature: 0,
    prompt_cache_key: "PRIVATE",
    user: "PRIVATE",
    safety_identifier: "PRIVATE",
    future_account_identity: "PRIVATE",
    metadata: { user_id: "PRIVATE" },
  });
  const result = JSON.parse(projectPortalPayload(input, "upstream_request"));
  expect(result).toMatchObject({
    model: "model",
    input: "user@example.com",
    stream: true,
    tools: [],
    temperature: 0,
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(result).not.toHaveProperty("prompt_cache_key");
});
