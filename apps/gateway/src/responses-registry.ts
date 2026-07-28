import type { ConfigStore, ResponsesRegistryStore } from "@helm/core";
import type { MessagesIdentity } from "./routes/messages.js";
import type { ResponsesRegistryPort, ResponsesRegistryRecord } from "./routes/responses.js";

const RESPONSES_REGISTRY_KEY = "responses_registry_v1";
const REGISTRY_MAX_ENTRIES = 10_000;
const REGISTRY_PRUNE_INTERVAL_MS = 5 * 60_000;
const REGISTRY_PRUNE_BATCH_SIZE = 1_000;

interface RegistryBlob {
  records: ResponsesRegistryRecord[];
}

function isProtocol(value: unknown): value is ResponsesRegistryRecord["providerProtocol"] {
  return (
    value === null ||
    value === "openai_chat" ||
    value === "anthropic_messages" ||
    value === "openai_responses" ||
    value === "gemini"
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseRecord(value: unknown): ResponsesRegistryRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.responseId !== "string" ||
    typeof row.accountId !== "string" ||
    typeof row.keyId !== "string" ||
    typeof row.createdAt !== "number" ||
    typeof row.expiresAt !== "number" ||
    typeof row.status !== "string" ||
    !isProtocol(row.providerProtocol)
  ) {
    return null;
  }
  return {
    responseId: row.responseId,
    accountId: row.accountId,
    keyId: row.keyId,
    providerAlias: stringOrNull(row.providerAlias),
    providerName: stringOrNull(row.providerName),
    providerModel: stringOrNull(row.providerModel),
    providerProtocol: row.providerProtocol,
    providerAccount: stringOrNull(row.providerAccount),
    selectedLane: stringOrNull(row.selectedLane),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
  };
}

function parseBlob(raw: string | null): Map<string, ResponsesRegistryRecord> {
  if (raw === null) return new Map();
  try {
    const parsed = JSON.parse(raw) as Partial<RegistryBlob>;
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    return new Map(
      records
        .map((record) => parseRecord(record))
        .filter((record): record is ResponsesRegistryRecord => record !== null)
        .map((record) => [record.responseId, record]),
    );
  } catch {
    return new Map();
  }
}

export function createResponsesRegistry(
  store: ResponsesRegistryStore,
  legacyConfig?: ConfigStore,
  opts: { now?: () => number } = {},
): ResponsesRegistryPort {
  const now = opts.now ?? (() => Date.now());
  const pending = new Map<string, ResponsesRegistryRecord>();
  let lastPrunedAt = now();
  let legacy: Promise<Map<string, ResponsesRegistryRecord>> | null = null;
  const loadLegacy = () => {
    if (legacy === null) {
      legacy = legacyConfig
        ? legacyConfig
            .get(RESPONSES_REGISTRY_KEY)
            .then(parseBlob)
            .catch(() => new Map())
        : Promise.resolve(new Map());
    }
    return legacy;
  };
  const persist = async (record: ResponsesRegistryRecord) => {
    await store.upsert(record);
    const nowMs = now();
    if (nowMs - lastPrunedAt < REGISTRY_PRUNE_INTERVAL_MS) return;
    lastPrunedAt = nowMs;
    await store.prune({
      nowMs,
      maxEntries: REGISTRY_MAX_ENTRIES,
      limit: REGISTRY_PRUNE_BATCH_SIZE,
    });
  };

  return {
    async put(record) {
      pending.set(record.responseId, record);
      try {
        await persist(record);
      } finally {
        if (pending.get(record.responseId) === record) pending.delete(record.responseId);
      }
    },
    async get(responseId: string, identity: MessagesIdentity) {
      const pendingRecord = pending.get(responseId);
      if (pendingRecord) {
        if (
          pendingRecord.accountId !== identity.accountId ||
          pendingRecord.keyId !== identity.keyId ||
          pendingRecord.expiresAt <= now() ||
          pendingRecord.status === "deleted"
        ) {
          return null;
        }
        return pendingRecord;
      }
      const live = await store.getOwnedLive({
        responseId,
        accountId: identity.accountId,
        keyId: identity.keyId,
        nowMs: now(),
      });
      if (live) return live;
      const record = (await loadLegacy()).get(responseId);
      if (!record) return null;
      if (record.accountId !== identity.accountId || record.keyId !== identity.keyId) return null;
      if (record.expiresAt <= now() || record.status === "deleted") return null;
      await persist(record);
      return record;
    },
  };
}
