import type { ConfigStore } from "@helm/core";
import { describe, expect, it } from "vitest";
import { createResponsesRegistry } from "./responses-registry.js";
import type { MessagesIdentity } from "./routes/messages.js";
import type { ResponsesRegistryRecord } from "./routes/responses.js";

function fakeConfigStore(seed: Record<string, string> = {}): ConfigStore & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
  };
}

const identity: MessagesIdentity = { keyId: "k1", accountId: "acct" };

function record(over: Partial<ResponsesRegistryRecord> = {}): ResponsesRegistryRecord {
  return {
    responseId: "resp_1",
    accountId: "acct",
    keyId: "k1",
    providerAlias: "responses/gpt-5.5",
    providerName: "openai",
    providerModel: "gpt-5.5",
    providerProtocol: "openai_responses",
    providerAccount: "oauth-a",
    selectedLane: "coding",
    createdAt: 1000,
    expiresAt: 2000,
    status: "completed",
    ...over,
  };
}

describe("createResponsesRegistry", () => {
  it("persists response ids across fresh registry instances", async () => {
    const store = fakeConfigStore();
    await createResponsesRegistry(store, { now: () => 1000 }).put(record());

    const fresh = createResponsesRegistry(store, { now: () => 1000 });
    await expect(fresh.get("resp_1", identity)).resolves.toMatchObject({
      responseId: "resp_1",
      providerName: "openai",
      providerProtocol: "openai_responses",
      providerAccount: "oauth-a",
      selectedLane: "coding",
    });
  });

  it("prunes expired records and returns null", async () => {
    const store = fakeConfigStore();
    const registry = createResponsesRegistry(store, { now: () => 3000 });
    await registry.put(record({ expiresAt: 2000 }));
    await expect(registry.get("resp_1", identity)).resolves.toBeNull();
  });
});
