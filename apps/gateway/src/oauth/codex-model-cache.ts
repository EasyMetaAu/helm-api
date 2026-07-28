import { type ConfigStore, decryptSecret, encryptSecret } from "@helm/core";
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

interface PersistedCodexModelCache {
  version: 1;
  entries: CodexModelCacheEntry[];
}

interface LoadedCodexModelCache {
  entries: CodexModelCacheEntry[];
  needsCleanup: boolean;
}

const mutationQueues = new WeakMap<ConfigStore, Promise<void>>();

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

function sameKey(left: CodexModelCacheKey, right: CodexModelCacheKey): boolean {
  return (
    left.providerId === right.providerId &&
    left.account === right.account &&
    left.accountIdentity === right.accountIdentity &&
    left.clientVersion === right.clientVersion
  );
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

function boundEntries(values: readonly unknown[], maxEntries: number): CodexModelCacheEntry[] {
  const sorted = values
    .map(parseEntry)
    .filter((entry): entry is CodexModelCacheEntry => entry !== null)
    .sort((left, right) => right.fetchedAtMs - left.fetchedAtMs);
  const seen = new Set<string>();
  const bounded: CodexModelCacheEntry[] = [];
  for (const entry of sorted) {
    const id = keyId(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    bounded.push(entry);
    if (bounded.length >= maxEntries) break;
  }
  return bounded;
}

async function loadEntries(
  config: ConfigStore,
  encKey: Buffer,
  maxEntries: number,
): Promise<LoadedCodexModelCache> {
  try {
    const blob = await config.get(CODEX_MODEL_CACHE_CONFIG_KEY);
    if (!blob) return { entries: [], needsCleanup: false };
    const parsed: unknown = JSON.parse(decryptSecret(blob, encKey));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { entries: [], needsCleanup: false };
    }
    const entries = boundEntries(parsed.entries, maxEntries);
    return {
      entries,
      needsCleanup: JSON.stringify(parsed.entries) !== JSON.stringify(entries),
    };
  } catch {
    return { entries: [], needsCleanup: false };
  }
}

async function saveEntries(
  config: ConfigStore,
  encKey: Buffer,
  entries: CodexModelCacheEntry[],
): Promise<void> {
  try {
    const payload: PersistedCodexModelCache = {
      version: 1,
      entries: entries.map(cloneEntry),
    };
    await config.set(CODEX_MODEL_CACHE_CONFIG_KEY, encryptSecret(JSON.stringify(payload), encKey));
  } catch {
    // Model discovery is an optimization; persistence failure must not block routing.
  }
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function serializeMutation<T>(
  config: ConfigStore,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = mutationQueues.get(config) ?? Promise.resolve();
  const run = previous.then(
    () => {
      signal?.throwIfAborted();
      return work();
    },
    () => {
      signal?.throwIfAborted();
      return work();
    },
  );
  mutationQueues.set(
    config,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return waitForSignal(run, signal);
}

export function createCodexModelCache(
  config: ConfigStore,
  encKey: Buffer,
  options: CodexModelCacheOptions = {},
): CodexModelCache {
  const now = options.now ?? (() => Date.now());
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_CODEX_MODEL_CACHE_TTL_MS);
  const maxEntries =
    options.maxEntries === undefined || !Number.isFinite(options.maxEntries)
      ? DEFAULT_CODEX_MODEL_CACHE_MAX_ENTRIES
      : Math.max(1, Math.floor(options.maxEntries));
  let hotEntries: CodexModelCacheEntry[] | null = null;
  let hydration: Promise<CodexModelCacheEntry[]> | null = null;

  const hydrate = (signal?: AbortSignal): Promise<CodexModelCacheEntry[]> => {
    if (hotEntries !== null) return Promise.resolve(hotEntries);
    if (hydration === null) {
      hydration = serializeMutation(config, async () => {
        const loaded = await loadEntries(config, encKey, maxEntries);
        if (loaded.needsCleanup) await saveEntries(config, encKey, loaded.entries);
        hotEntries = loaded.entries;
        return loaded.entries;
      }).finally(() => {
        hydration = null;
      });
    }
    return waitForSignal(hydration, signal);
  };

  return {
    async get(key, signal) {
      const normalizedKey = normalizeKey(key);
      if (normalizedKey === null) return null;
      const entries = await hydrate(signal);
      const entry = entries.find((candidate) => sameKey(candidate, normalizedKey));
      if (!entry) return null;
      return {
        entry: cloneEntry(entry),
        fresh: now() - entry.fetchedAtMs < ttlMs,
      };
    },

    async upsert(entry) {
      const normalized = parseEntry(entry);
      if (normalized === null) return null;
      return serializeMutation(config, async () => {
        const { entries } = await loadEntries(config, encKey, maxEntries);
        const next = cloneEntry(normalized);
        const index = entries.findIndex((candidate) => sameKey(candidate, next));
        if (index === -1) entries.push(next);
        else entries[index] = next;
        const bounded = boundEntries(entries, maxEntries);
        await saveEntries(config, encKey, bounded);
        hotEntries = bounded;
        return cloneEntry(next);
      });
    },

    async renew(key, etag) {
      const normalizedKey = normalizeKey(key);
      if (normalizedKey === null) return null;
      return serializeMutation(config, async () => {
        const { entries } = await loadEntries(config, encKey, maxEntries);
        const index = entries.findIndex((candidate) => sameKey(candidate, normalizedKey));
        if (index === -1 || entries[index]?.etag !== etag) return null;
        const renewed = cloneEntry({
          ...entries[index],
          fetchedAtMs: now(),
        });
        entries[index] = renewed;
        const bounded = boundEntries(entries, maxEntries);
        await saveEntries(config, encKey, bounded);
        hotEntries = bounded;
        return cloneEntry(renewed);
      });
    },
  };
}
