import { describe, expect, it } from "vitest";
import {
  createResponseWorkAdmission,
  runtimeResponseWorkAdmission,
} from "../../runtime/response-work-admission.js";
import { createTokenManager, TokenRefreshError } from "../token-manager.js";
import { refreshAnthropicToken } from "./anthropic.js";
import { refreshGitHubCopilotToken } from "./github-copilot.js";
import { listAnthropicModels, listOpenAICodexModels } from "./models.js";
import { refreshOpenAICodexToken } from "./openai-codex.js";

const CONFIDENTIAL_OAUTH = {
  grant: "refresh_token" as const,
  tokenUrl: "https://oauth.test/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-secret",
  scopes: [],
};

function declaredOversizedResponse(status = 200) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      status,
      headers: { "content-length": String(runtimeResponseWorkAdmission().capacityBytes + 1) },
    }),
    cancelled: () => cancelled,
  };
}

type ResponseCall = (response: Response) => Promise<unknown>;

const successCalls: Array<[string, ResponseCall]> = [
  [
    "confidential token refresh",
    (response) =>
      createTokenManager({
        oauth: CONFIDENTIAL_OAUTH,
        fetch: async () => response,
      }).getAuthHeader(),
  ],
  [
    "OpenAI Codex token refresh",
    (response) => refreshOpenAICodexToken("refresh", async () => response),
  ],
  ["Anthropic token refresh", (response) => refreshAnthropicToken("refresh", async () => response)],
  [
    "GitHub Copilot token refresh",
    (response) => refreshGitHubCopilotToken("github", undefined, async () => response),
  ],
  [
    "OpenAI Codex model discovery",
    (response) => listOpenAICodexModels("access", { fetchImpl: async () => response }),
  ],
  ["Anthropic model discovery", (response) => listAnthropicModels("access", async () => response)],
];

describe("bounded OAuth success responses", () => {
  it.each(successCalls)("cancels a declared oversized %s body", async (_name, run) => {
    const fixture = declaredOversizedResponse();

    await expect(run(fixture.response)).rejects.toThrow();
    expect(fixture.cancelled()).toBe(true);
  });

  it("cancels chunked overflow, unlocks the stream, and releases response work", async () => {
    const work = createResponseWorkAdmission({
      capacityBytes: 32,
      jsonAmplification: 1,
      minChargeBytes: 1,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify({ access_token: "a".repeat(64), expires_in: 3600 }),
    );
    let cancelled = false;
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(chunk++ === 0 ? bytes.subarray(0, 16) : bytes.subarray(16));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const manager = createTokenManager({
      oauth: CONFIDENTIAL_OAUTH,
      fetch: async () => new Response(body),
      responseWorkAdmission: work,
    });

    await expect(manager.getAuthHeader()).rejects.toBeInstanceOf(TokenRefreshError);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
    expect(work.reservedBytes).toBe(0);
  });
});

describe("bounded OAuth error responses", () => {
  it.each(
    successCalls,
  )("keeps the scrubbed %s error contract and cancels its body", async (_name, run) => {
    const fixture = declaredOversizedResponse(401);

    await expect(run(fixture.response)).rejects.toThrow(/401|HTTP|token request failed/i);
    expect(fixture.cancelled()).toBe(true);
  });
});
