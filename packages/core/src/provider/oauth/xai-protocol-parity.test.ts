import { describe, expect, it } from "vitest";
import { XAI_GROK_CLIENT_VERSION, XAI_OAUTH_SCOPE, xaiGrokInferenceHeaders } from "./xai.js";

describe("xAI Grok Build protocol parity", () => {
  it("tracks the installed first-party client version and complete personal scopes", () => {
    expect(XAI_GROK_CLIENT_VERSION).toBe("0.2.101");
    expect(XAI_OAUTH_SCOPE.split(" ")).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "grok-cli:access",
      "api:access",
      "conversations:read",
      "conversations:write",
    ]);
  });

  it("identifies headless Helm inference requests without dropping required proxy headers", () => {
    expect(xaiGrokInferenceHeaders("grok-4.5")).toEqual({
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-version": "0.2.101",
      "x-grok-client-identifier": "helm-api",
      "x-grok-client-mode": "headless",
      "x-grok-model-override": "grok-4.5",
    });
  });
});
