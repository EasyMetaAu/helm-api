import type { ConfigStore } from "@helm/core";
import type { MessagesIdentity } from "./routes/messages.js";
import type { ResponsesRegistryPort, ResponsesRegistryRecord } from "./routes/responses.js";

const RESPONSES_REGISTRY_KEY = "responses_registry_v1";
const REGISTRY_MAX_ENTRIES = 10_000;

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

function serialize(map: Map<string, ResponsesRegistryRecord>, now: number): string {
  const records = [...map.values()]
    .filter((record) => record.expiresAt > now && record.status !== "deleted")
    .sort((a, b) => a.createdAt - b.createdAt);
  const trimmed =
    records.length > REGISTRY_MAX_ENTRIES
      ? records.slice(records.length - REGISTRY_MAX_ENTRIES)
      : records;
  return JSON.stringify({ records: trimmed } satisfies RegistryBlob);
}

export function createResponsesRegistry(
  config: ConfigStore,
  opts: { now?: () => number } = {},
): ResponsesRegistryPort {
  const now = opts.now ?? (() => Date.now());
  let mutation = Promise.resolve();

  const load = async (): Promise<Map<string, ResponsesRegistryRecord>> => {
    try {
      return parseBlob(await config.get(RESPONSES_REGISTRY_KEY));
    } catch {
      return new Map();
    }
  };

  const save = async (map: Map<string, ResponsesRegistryRecord>): Promise<void> => {
    try {
      await config.set(RESPONSES_REGISTRY_KEY, serialize(map, now()));
    } catch {
      // Lifecycle registry persistence is best-effort; a storage outage must not
      // turn a successfully served model response into a failed client request.
    }
  };

  const mutate = async <T>(
    fn: (map: Map<string, ResponsesRegistryRecord>) => Promise<T>,
  ): Promise<T> => {
    const run = mutation.then(async () => {
      const map = await load();
      return fn(map);
    });
    mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    put(record) {
      return mutate(async (map) => {
        map.set(record.responseId, record);
        await save(map);
      });
    },
    async get(responseId: string, identity: MessagesIdentity) {
      const map = await load();
      const record = map.get(responseId);
      if (record === undefined) return null;
      if (record.accountId !== identity.accountId || record.keyId !== identity.keyId) return null;
      if (record.expiresAt <= now() || record.status === "deleted") {
        await mutate(async (fresh) => {
          fresh.delete(responseId);
          await save(fresh);
        });
        return null;
      }
      return record;
    },
  };
}
