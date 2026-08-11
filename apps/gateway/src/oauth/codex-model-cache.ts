import type { ConfigStore } from "@helm/core";
import { normalizeOpenAICodexClientVersion } from "./codex-client-version.js";

export const CODEX_MODEL_CACHE_CONFIG_KEY = "oauth.codex_model_cache";
export const DEFAULT_CODEX_MODEL_CACHE_TTL_MS = 300_000;
export const DEFAULT_CODEX_MODEL_CACHE_MAX_ENTRIES = 64;

export type CodexCachedModel = Record<string, unknown>;

export interface CodexModelCacheKey {
  providerId: string;
  account: string;
  accountIdentity: string;
  clientVersion: string;
}

export interface CodexModelCacheEntry extends CodexModelCacheKey {
  fetchedAtMs: number;
  etag: string | null;
  reasoningIncluded: boolean;
  models: CodexCachedModel[];
}

export interface CodexModelCacheHit {
  entry: CodexModelCacheEntry;
  fresh: boolean;
}

export interface CodexModelCache {
  get(key: CodexModelCacheKey, signal?: AbortSignal): Promise<CodexModelCacheHit | null>;
  upsert(entry: CodexModelCacheEntry): Promise<CodexModelCacheEntry | null>;
  renew(key: CodexModelCacheKey, etag: string | null): Promise<CodexModelCacheEntry | null>;
}

export interface CodexModelCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): CodexModelCacheEntry | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.providerId !== "string" ||
    typeof value.account !== "string" ||
    typeof value.accountIdentity !== "string" ||
    typeof value.clientVersion !== "string" ||
    typeof value.fetchedAtMs !== "number" ||
    !Number.isFinite(value.fetchedAtMs) ||
    (value.etag !== null && typeof value.etag !== "string") ||
    (value.reasoningIncluded !== undefined && typeof value.reasoningIncluded !== "boolean") ||
    !Array.isArray(value.models) ||
    !value.models.every(isRecord)
  ) {
    return null;
  }
  const clientVersion = normalizeOpenAICodexClientVersion(value.clientVersion);
  if (clientVersion === null) return null;
  return {
    providerId: value.providerId,
    account: value.account,
    accountIdentity: value.accountIdentity,
    clientVersion,
    fetchedAtMs: value.fetchedAtMs,
    etag: value.etag,
    reasoningIncluded: value.reasoningIncluded === true,
    models: value.models.map((model) => ({ ...model })),
  };
}

function normalizeKey(key: CodexModelCacheKey): CodexModelCacheKey | null {
  const clientVersion = normalizeOpenAICodexClientVersion(key.clientVersion);
  return clientVersion === null ? null : { ...key, clientVersion };
}

function keyId(key: CodexModelCacheKey): string {
  return JSON.stringify([key.providerId, key.account, key.accountIdentity, key.clientVersion]);
}

function cloneEntry(entry: CodexModelCacheEntry): CodexModelCacheEntry {
  return {
    ...entry,
    models: entry.models.map((model) => ({ ...model })),
  };
}

export function createCodexModelCache(
  _config: ConfigStore,
  _encKey: Buffer,
  options: CodexModelCacheOptions = {},
): CodexModelCache {
  const now = options.now ?? (() => Date.now());
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_CODEX_MODEL_CACHE_TTL_MS);
  const maxEntries =
    options.maxEntries === undefined || !Number.isFinite(options.maxEntries)
      ? DEFAULT_CODEX_MODEL_CACHE_MAX_ENTRIES
      : Math.max(1, Math.floor(options.maxEntries));
  // Model discovery is an optimization. Keep it process-local so the legacy
  // aggregate encrypted blob can never be materialized on a request path.
  const hotEntries = new Map<string, CodexModelCacheEntry>();

  const remember = (entry: CodexModelCacheEntry): void => {
    const id = keyId(entry);
    hotEntries.delete(id);
    hotEntries.set(id, entry);
    while (hotEntries.size > maxEntries) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidateId, candidate] of hotEntries) {
        if (candidate.fetchedAtMs < oldestAt) {
          oldestId = candidateId;
          oldestAt = candidate.fetchedAtMs;
        }
      }
      if (oldestId === undefined) break;
      hotEntries.delete(oldestId);
    }
  };

  return {
    async get(key, signal) {
      signal?.throwIfAborted();
      const normalizedKey = normalizeKey(key);
      if (normalizedKey === null) return null;
      const entry = hotEntries.get(keyId(normalizedKey));
      if (!entry) return null;
      return {
        entry: cloneEntry(entry),
        fresh: now() - entry.fetchedAtMs < ttlMs,
      };
    },

    async upsert(entry) {
      const normalized = parseEntry(entry);
      if (normalized === null) return null;
      remember(normalized);
      return cloneEntry(normalized);
    },

    async renew(key, etag) {
      const normalizedKey = normalizeKey(key);
      if (normalizedKey === null) return null;
      const id = keyId(normalizedKey);
      const entry = hotEntries.get(id);
      if (!entry || entry.etag !== etag) return null;
      const renewed = cloneEntry({ ...entry, fetchedAtMs: now() });
      hotEntries.set(id, renewed);
      return cloneEntry(renewed);
    },
  };
}
