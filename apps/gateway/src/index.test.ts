import { describe, expect, it } from "vitest";
import { isResponsesWebSocketPath } from "./responses-websocket.js";

describe("isResponsesWebSocketPath", () => {
  it.each([
    "/v1/responses",
    "/responses",
    "/openai/v1/responses",
    "/v1/responses?model=gpt-5.6",
  ])("matches Codex Responses websocket upgrade path %s", (path) => {
    expect(isResponsesWebSocketPath(path)).toBe(true);
  });

  it.each([
    undefined,
    "/v1/responses/compact",
    "/v1/responses/input_tokens",
    "/v1/chat/completions",
    "/admin",
  ])("does not match non-create path %s", (path) => {
    expect(isResponsesWebSocketPath(path)).toBe(false);
  });
});
