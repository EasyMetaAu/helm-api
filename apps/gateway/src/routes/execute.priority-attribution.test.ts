import { createCircuitBreaker, type ProviderClient, UpstreamError } from "@helm/core";
import { InternalRequestSchema } from "@helm/shared";
import { expect, it, vi } from "vitest";
import { markServingAccount, withServingAccountCapture } from "../runtime/serving-account.js";
import { createExecute } from "./execute.js";

// Exercise the handoff when a group completes without adding an attempt: the last
// attempt still belongs to the earlier sequential alias, outside the group's holders.
vi.mock("@helm/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@helm/core")>()),
  coordinateAccountPriority: vi.fn(async () => undefined),
}));

it("an empty group handoff does not erase the preceding non-group account", async () => {
  const prior: ProviderClient = {
    async chatCompletion() {
      markServingAccount("prior", "prior-account", ["prior/other"]);
      throw new UpstreamError("upstream_error", "fixture failure", null, 503);
    },
    chatCompletionStream() {
      throw new Error("unused");
    },
  };
  const member = (kind: "oauth" | "api_key", priority: number): ProviderClient => ({
    ...prior,
    accountPriority: {
      kind,
      snapshot: async () => [{ account: kind, priority, eligible: true }],
      isPinned: () => false,
    },
  });
  const execute = createExecute({
    defaultProvider: prior,
    providers: new Map([
      ["prior", prior],
      ["subscription", member("oauth", 10)],
      ["key", member("api_key", 20)],
    ]),
    registry: {
      list: () => [],
      resolve: (alias) => ({ ok: false, error: { kind: "unknown_alias", alias } }),
    },
    catalog: new Map(),
    breaker: createCircuitBreaker({
      config: { failureThreshold: 5, cooldownMs: 1000 },
      now: () => 0,
    }),
    signal: new AbortController().signal,
    now: () => 0,
  });
  const captured = await withServingAccountCapture(() =>
    execute(
      {
        selected_lane: "balanced",
        candidate_chain: ["prior/other", "subscription/model", "key/model"],
        explicit_model: null,
      },
      InternalRequestSchema.parse({
        request_id: "attribution-handoff",
        protocol: "openai_chat",
        account_id: "owner",
        api_key_id: "key",
        user_id: null,
        org_id: null,
        requested_model: "auto",
        messages: [{ role: "user", content: "hello" }],
        tools: null,
        response_format: null,
        attachments: null,
        max_tokens: null,
        stream: false,
        metadata: {
          conversation_id: null,
          thread_id: null,
          resource_id: null,
          project_id: null,
          memory_mode: "off",
        },
      }),
    ),
  );
  expect(captured.result.attempts.map((attempt) => attempt.alias)).toEqual(["prior/other"]);
  expect(captured.servingAccount).toMatchObject({ providerId: "prior", account: "prior-account" });
});
