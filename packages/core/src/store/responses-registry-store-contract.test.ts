import { describe, expect, it } from "vitest";
import type { ResponsesRegistryRecord, ResponsesRegistryStore } from "./ports.js";
import { createPgliteDb } from "./postgres/migrate.js";
import { PgResponsesRegistryStore } from "./postgres/responses-registry.js";
import { createSqliteDb } from "./sqlite/migrate.js";
import { SqliteResponsesRegistryStore } from "./sqlite/responses-registry.js";

const identity = { accountId: "acct", keyId: "key" };

function record(responseId: string, createdAt: number): ResponsesRegistryRecord {
  return {
    responseId,
    ...identity,
    providerAlias: "openai-codex/gpt-5.6-sol",
    providerName: "openai-codex",
    providerModel: "gpt-5.6-sol",
    providerProtocol: "openai_responses",
    providerAccount: "default",
    selectedLane: "coding",
    createdAt,
    expiresAt: 10_000,
    status: "completed",
  };
}

async function verify(store: ResponsesRegistryStore): Promise<void> {
  for (const kind of ["video", "three-d", "transcription"]) {
    await store.insertIfAbsent({
      ...record(`${kind}:paid`, 1),
      selectedLane: kind,
      expiresAt: 7 * 86400000,
    });
    await store.insertIfAbsent({
      ...record(`${kind}-create:pending`, 1),
      selectedLane: kind,
      expiresAt: 7 * 86400000,
    });
  }
  expect(await store.insertIfAbsent(record("video-create:req_1", 500))).toBe(true);
  expect(await store.insertIfAbsent(record("video-create:req_1", 600))).toBe(false);

  await Promise.all([store.upsert(record("resp_1", 1_000)), store.upsert(record("resp_2", 2_000))]);
  await expect(
    store.getOwnedLive({ responseId: "resp_1", ...identity, nowMs: 3_000 }),
  ).resolves.toMatchObject({ responseId: "resp_1", providerAccount: "default" });
  await expect(
    store.getOwnedLive({ responseId: "resp_2", accountId: "other", keyId: "key", nowMs: 3_000 }),
  ).resolves.toBeNull();

  const toolTranslation = { toolNames: ["exec"], pendingCallIds: ["call_2"] };
  await store.upsert({ ...record("resp_2", 2_000), toolTranslation });
  await expect(
    store.getOwnedLive({ responseId: "resp_2", ...identity, nowMs: 3_000 }),
  ).resolves.toMatchObject({ toolTranslation });
  await expect(
    store.getOwnedLive({ responseId: "resp_2", accountId: "acct", keyId: "other", nowMs: 3_000 }),
  ).resolves.toBeNull();

  await store.upsert(record("resp_3", 3_000));
  await store.prune({ nowMs: 3_000, maxEntries: 2, limit: 1_000 });
  await expect(
    store.getOwnedLive({ responseId: "resp_1", ...identity, nowMs: 3_000 }),
  ).resolves.toBeNull();
  await expect(
    store.getOwnedLive({ responseId: "resp_3", ...identity, nowMs: 10_000 }),
  ).resolves.toBeNull();
  for (const kind of ["video", "three-d", "transcription"]) {
    for (const responseId of [`${kind}:paid`, `${kind}-create:pending`]) {
      await expect(
        store.getOwnedLive({ responseId, ...identity, nowMs: 6 * 86400000 }),
      ).resolves.toMatchObject({ responseId });
    }
  }
  await store.prune({ nowMs: 7 * 86400000, maxEntries: 2, limit: 1000 });
  for (const kind of ["video", "three-d", "transcription"]) {
    await expect(
      store.getOwnedLive({ responseId: `${kind}:paid`, ...identity, nowMs: 7 * 86400000 }),
    ).resolves.toBeNull();
  }
}

describe("ResponsesRegistryStore contract", () => {
  it("uses keyed rows on SQLite", async () => {
    const db = createSqliteDb(":memory:");
    try {
      await verify(new SqliteResponsesRegistryStore(db));
    } finally {
      db.$sqlite.close();
    }
  });

  it("uses keyed rows on Postgres", async () => {
    const db = await createPgliteDb();
    try {
      await verify(new PgResponsesRegistryStore(db));
    } finally {
      await db.$close();
    }
  });
});
