import { createHash } from "node:crypto";
import {
  type CodexModelInfo,
  CodexModelInfoSchema,
  isRetiredOpenAICodexModel,
  type OpenAICodexModelsResult,
  resolveOpenAICodexModelAlias,
} from "@helm/core";
import { normalizeOpenAICodexClientVersion } from "./codex-client-version.js";
import type {
  CodexModelCache,
  CodexModelCacheEntry,
  CodexModelCacheKey,
} from "./codex-model-cache.js";

export const DEFAULT_CODEX_MODEL_CATALOG_MAX_ENTRIES = 64;

export interface CodexModelCatalogSnapshot {
  models: CodexModelInfo[];
  etag: string | null;
  reasoningIncluded: boolean;
  source: "bundled" | "fresh-cache" | "network" | "stale-cache";
}

export interface CodexModelCatalog {
  load(
    key: CodexModelCacheKey,
    fetchModels: () => Promise<OpenAICodexModelsResult>,
  ): Promise<CodexModelCatalogSnapshot | null>;
  snapshot(key: CodexModelCacheKey): CodexModelCatalogSnapshot | undefined;
  resolve(key: CodexModelCacheKey, model: string): CodexModelInfo | undefined;
  listRoutable(
    models: Iterable<string>,
    scope?: { keys?: readonly CodexModelCacheKey[] },
  ): OpenAICodexModelsResult | null;
  observeEtag(
    key: CodexModelCacheKey,
    etag: string,
    fetchModels: () => Promise<OpenAICodexModelsResult>,
    onChanged?: () => void,
  ): Promise<void>;
}

export interface CodexModelCatalogOptions {
  cache: CodexModelCache;
  bundledModels?: readonly unknown[];
  maxEntries?: number;
  now?: () => number;
  onRefresh?: () => void;
}

function normalizedKey(key: CodexModelCacheKey): CodexModelCacheKey | null {
  const clientVersion = normalizeOpenAICodexClientVersion(key.clientVersion);
  return clientVersion === null ? null : { ...key, clientVersion };
}

function cacheKey(key: CodexModelCacheKey): string {
  return JSON.stringify([key.providerId, key.account, key.accountIdentity, key.clientVersion]);
}

function parseModels(models: readonly unknown[]): CodexModelInfo[] | null {
  const parsed: CodexModelInfo[] = [];
  for (const model of models) {
    const result = CodexModelInfoSchema.safeParse(model);
    if (!result.success) return null;
    if (isRetiredOpenAICodexModel(result.data.slug)) continue;
    parsed.push(result.data);
  }
  return parsed;
}

function sameCatalog(
  left: CodexModelCatalogSnapshot | undefined,
  models: readonly CodexModelInfo[],
  etag: string | null,
  reasoningIncluded: boolean,
): boolean {
  return (
    left?.etag === etag &&
    left.reasoningIncluded === reasoningIncluded &&
    JSON.stringify(left.models) === JSON.stringify(models)
  );
}

function semanticVersion(
  value: string | readonly [number, number, number],
): readonly [number, number, number] | null {
  if (typeof value !== "string") {
    return value.every((part) => Number.isSafeInteger(part) && part >= 0)
      ? [value[0], value[1], value[2]]
      : null;
  }
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function supportsBundledModel(clientVersion: string, model: CodexModelInfo): boolean {
  if (!model.minimal_client_version) return true;
  const client = semanticVersion(clientVersion);
  const minimum = semanticVersion(model.minimal_client_version);
  if (!client || !minimum) return true;
  for (let index = 0; index < client.length; index += 1) {
    if (client[index] !== minimum[index]) return (client[index] ?? 0) > (minimum[index] ?? 0);
  }
  return true;
}

export function createCodexModelCatalog(options: CodexModelCatalogOptions): CodexModelCatalog {
  const now = options.now ?? (() => Date.now());
  const maxEntries =
    options.maxEntries === undefined || !Number.isFinite(options.maxEntries)
      ? DEFAULT_CODEX_MODEL_CATALOG_MAX_ENTRIES
      : Math.max(1, Math.floor(options.maxEntries));
  const bundledModels = parseModels(options.bundledModels ?? []) ?? [];
  const current = new Map<string, CodexModelCatalogSnapshot>();
  const refreshes = new Map<string, Promise<CodexModelCatalogSnapshot | null>>();
  const observations = new Map<string, Promise<void>>();

  function currentSnapshot(key: CodexModelCacheKey): CodexModelCatalogSnapshot | undefined {
    const id = cacheKey(key);
    const snapshot = current.get(id);
    if (snapshot) {
      current.delete(id);
      current.set(id, snapshot);
    }
    return snapshot;
  }

  function apply(
    key: CodexModelCacheKey,
    models: CodexModelInfo[],
    etag: string | null,
    reasoningIncluded: boolean,
    source: CodexModelCatalogSnapshot["source"],
  ): CodexModelCatalogSnapshot {
    const snapshot = { models, etag, reasoningIncluded, source };
    const id = cacheKey(key);
    current.delete(id);
    current.set(id, snapshot);
    while (current.size > maxEntries) {
      const oldest = current.keys().next().value;
      if (oldest === undefined) break;
      current.delete(oldest);
    }
    return snapshot;
  }

  function bundledModelsFor(clientVersion: string): CodexModelInfo[] {
    return bundledModels.filter((model) => supportsBundledModel(clientVersion, model));
  }

  function applyRemoteModels(
    key: CodexModelCacheKey,
    models: readonly CodexModelInfo[],
  ): CodexModelInfo[] {
    if (models.some((model) => model.visibility === "list")) return [...models];
    const merged = bundledModelsFor(key.clientVersion);
    for (const model of models) {
      const index = merged.findIndex((candidate) => candidate.slug === model.slug);
      if (index === -1) merged.push(model);
      else merged[index] = model;
    }
    return merged;
  }

  async function refresh(
    key: CodexModelCacheKey,
    fetchModels: () => Promise<OpenAICodexModelsResult>,
  ): Promise<CodexModelCatalogSnapshot | null> {
    const id = cacheKey(key);
    const active = refreshes.get(id);
    if (active) return active;
    if (refreshes.size >= maxEntries) return null;
    const run = (async () => {
      const result = await fetchModels();
      const models = parseModels(result.models);
      if (!models) return null;
      const entry: CodexModelCacheEntry = {
        ...key,
        fetchedAtMs: now(),
        etag: result.etag ?? null,
        reasoningIncluded: result.reasoningIncluded === true,
        models,
      };
      await options.cache.upsert(entry);
      const snapshot = apply(
        key,
        applyRemoteModels(key, models),
        entry.etag,
        entry.reasoningIncluded,
        "network",
      );
      try {
        options.onRefresh?.();
      } catch {
        // ETag invalidation is advisory and must not break model discovery.
      }
      return snapshot;
    })().finally(() => {
      refreshes.delete(id);
    });
    refreshes.set(id, run);
    return run;
  }

  return {
    async load(key, fetchModels) {
      const normalized = normalizedKey(key);
      if (normalized === null) return null;
      const hit = await options.cache.get(normalized);
      const cachedModels = hit ? parseModels(hit.entry.models) : null;
      if (hit?.fresh && cachedModels) {
        const models = applyRemoteModels(normalized, cachedModels);
        if (models.length > 0) {
          return apply(
            normalized,
            models,
            hit.entry.etag,
            hit.entry.reasoningIncluded,
            "fresh-cache",
          );
        }
      }
      try {
        const online = await refresh(normalized, fetchModels);
        if (online) return online;
      } catch {
        // Last-known-good below.
      }
      if (hit && cachedModels) {
        const models = applyRemoteModels(normalized, cachedModels);
        if (models.length > 0) {
          return apply(
            normalized,
            models,
            hit.entry.etag,
            hit.entry.reasoningIncluded,
            "stale-cache",
          );
        }
      }
      const fallback = bundledModelsFor(normalized.clientVersion);
      if (fallback.length > 0) return apply(normalized, fallback, null, false, "bundled");
      return null;
    },

    snapshot(key) {
      const normalized = normalizedKey(key);
      return normalized === null ? undefined : currentSnapshot(normalized);
    },

    resolve(key, model) {
      const normalized = normalizedKey(key);
      if (normalized === null) return undefined;
      const snapshot = currentSnapshot(normalized);
      if (!snapshot) return undefined;
      const resolvedModel = resolveOpenAICodexModelAlias(model);
      return snapshot.models
        .filter((candidate) => resolvedModel.startsWith(candidate.slug))
        .sort((left, right) => right.slug.length - left.slug.length)[0];
    },

    listRoutable(models, scope) {
      const available = new Map<string, CodexModelInfo>();
      const snapshots = [
        ...(scope?.keys === undefined
          ? current.values()
          : scope.keys
              .map(normalizedKey)
              .filter((key): key is CodexModelCacheKey => key !== null)
              .map((key) => currentSnapshot(key))
              .filter((snapshot): snapshot is CodexModelCatalogSnapshot => snapshot !== undefined)),
      ];
      for (const snapshot of snapshots) {
        for (const model of snapshot.models) {
          const previous = available.get(model.slug);
          if (previous === undefined || model.priority < previous.priority) {
            available.set(model.slug, model);
          }
        }
      }
      const selected = new Map<string, CodexModelInfo>();
      for (const slug of new Set(models)) {
        const source = available.get(resolveOpenAICodexModelAlias(slug));
        if (source === undefined) continue;
        selected.set(slug, slug === source.slug ? source : { ...source, slug });
      }
      const combined = [...selected.values()].sort(
        (left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug),
      );
      if (combined.length === 0) return null;
      const digest = createHash("sha256").update(JSON.stringify(combined)).digest("hex");
      return {
        models: combined,
        etag: `"helm-codex-${digest}"`,
        ...(snapshots.length > 0 && snapshots.every((snapshot) => snapshot.reasoningIncluded)
          ? { reasoningIncluded: true }
          : {}),
      };
    },

    async observeEtag(key, etag, fetchModels, onChanged) {
      const normalized = normalizedKey(key);
      if (normalized === null) return;
      const id = cacheKey(normalized);
      const active = observations.get(id);
      if (active) return active;
      if (observations.size >= maxEntries) return;
      const run = (async () => {
        let snapshot = currentSnapshot(normalized);
        if (!snapshot) {
          const hit = await options.cache.get(normalized);
          const models = hit ? parseModels(hit.entry.models) : null;
          if (hit && models) {
            const applied = applyRemoteModels(normalized, models);
            if (applied.length === 0) return;
            snapshot = apply(
              normalized,
              applied,
              hit.entry.etag,
              hit.entry.reasoningIncluded,
              hit.fresh ? "fresh-cache" : "stale-cache",
            );
          }
        }
        if (snapshot?.etag === etag) {
          await options.cache.renew(normalized, etag);
          return;
        }
        const before = snapshot;
        try {
          const next = await refresh(normalized, fetchModels);
          if (next && !sameCatalog(before, next.models, next.etag, next.reasoningIncluded)) {
            onChanged?.();
          }
        } catch {
          // A response-side invalidation is advisory; serving must remain fail-open.
        }
      })().finally(() => {
        observations.delete(id);
      });
      observations.set(id, run);
      return run;
    },
  };
}
