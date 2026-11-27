import { ApiKeyAccounts } from "@helm/core";
import { expect, it, vi } from "vitest";
import { accountClient, ManagedAccountClients } from "./managed-provider-client.js";

it("pins media to the selected generation, enforces priority and fails closed after key rotation", async () => {
  const data = new Map<string, string>();
  const store = {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => {
      data.set(k, v);
    },
    compareAndSet: async (k: string, old: string | null, v: string) => {
      if ((data.get(k) ?? null) !== old) return false;
      data.set(k, v);
      return true;
    },
  };
  const accounts = new ApiKeyAccounts({
    store,
    encKey: Buffer.alloc(32, 4),
    poolId: "media",
    providerType: "compatible",
    timezone: "UTC",
  });
  await accounts.add([
    { name: "a", key: "vendor-first" },
    { name: "b", key: "vendor-second" },
  ]);
  await accounts.setStrategy("manual_priority");
  await accounts.update(accounts.entries()[1]!.id, { priority: 1 });
  const send = vi.fn(async () => ({ id: "job" }));
  const runtime = new ManagedAccountClients(accounts, "https://example.com", (a) => ({
    chatCompletion: send,
    async *chatCompletionStream() {
      yield "ok";
    },
    videoGeneration: async () => {
      await send();
      return { key: a.key };
    },
    videoRetrieve: send,
  }));
  const bound = runtime.select("model")!;
  expect(await bound.client.videoGeneration!({ model: "model" })).toEqual({ key: "vendor-second" });
  await accounts.update(accounts.entries()[1]!.id, {
    name: "renamed",
    parameters: { temperature: 0.4 },
    proxy: { type: "http", host: "127.0.0.1", port: 8888 },
  });
  expect(runtime.select("model", bound.owner)?.owner).toBe(bound.owner);
  expect(await runtime.select("model", bound.owner)!.client.videoRetrieve!("job")).toEqual({
    id: "job",
  });
  await expect(bound.client.videoRetrieve!("job")).rejects.toThrow();
  await accounts.update(accounts.entries()[0]!.id, { priority: 0 });
  expect(runtime.select("model", bound.owner)?.owner).toBe(bound.owner);
  await accounts.update(accounts.entries()[1]!.id, { key: "vendor-replaced" });
  expect(runtime.select("model", bound.owner)).toBeNull();
  await expect(bound.client.videoRetrieve!("job")).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(2);
});

it("applies protocol defaults without retaining a stale serialized native body", async () => {
  const send = vi.fn(async (body: unknown) => body);
  const base = {
    chatCompletion: send,
    async *chatCompletionStream() {
      yield "ok";
    },
    nativePassthrough: send,
  };
  const client = accountClient(
    base as never,
    { parameters: { temperature: 0.4, max_tokens: 100, reasoning_effort: "low" } } as never,
    async () => {},
  );
  const request = {
    protocol: "openai_responses",
    body: { model: "m", temperature: 0.7 },
    raw_body: '{"model":"m"}',
  };
  await client.nativePassthrough!(request as never);
  expect(send.mock.calls[0]?.[0]).toEqual({
    protocol: "openai_responses",
    raw_body: undefined,
    body: { model: "m", temperature: 0.7, max_output_tokens: 100, reasoning: { effort: "low" } },
  });
});

it.each([
  "bailian-default",
  null,
])("preserves imported media owner %s only for the verified original key and endpoint", async (owner) => {
  const data = new Map<string, string>();
  const store = {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => {
      data.set(k, v);
    },
    compareAndSet: async (k: string, old: string | null, v: string) => {
      if ((data.get(k) ?? null) !== old) return false;
      data.set(k, v);
      return true;
    },
  };
  const accounts = new ApiKeyAccounts({
    store,
    encKey: Buffer.alloc(32, 4),
    poolId: "media",
    providerType: "compatible",
    timezone: "UTC",
  });
  await accounts.add([
    { name: "imported", key: "original-media-key" },
    { name: "other", key: "different-media-key" },
  ]);
  const original = accounts.entries()[0]!;
  const legacy = {
    accountId: original.id,
    generation: original.generation,
    endpoint: "type:https://media.example",
    owner,
  };
  const send = vi.fn(async () => ({ id: "existing-job" }));
  const factory = () => ({
    chatCompletion: send,
    async *chatCompletionStream() {
      yield "ok";
    },
    videoRetrieve: send,
  });
  const runtime = new ManagedAccountClients(
    accounts,
    legacy.endpoint,
    factory,
    undefined,
    undefined,
    legacy,
  );
  expect(runtime.select("model", owner)?.owner).toBe(owner);
  expect(await runtime.select("model", owner)!.client.videoRetrieve!("job")).toEqual({
    id: "existing-job",
  });
  expect(
    new ManagedAccountClients(
      accounts,
      "type:https://other.example",
      factory,
      undefined,
      undefined,
      legacy,
    ).select("model", owner),
  ).toBeNull();
  await accounts.update(original.id, { key: "replacement-media-key" });
  expect(runtime.select("model", owner)).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
});
