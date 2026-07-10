import { createHash } from "node:crypto";
import { normalizeOpenAICodexClientVersion } from "./codex-client-version.js";

export const DEFAULT_CODEX_MODELS_ETAG_MAX_ENTRIES = 64;

export interface CodexModelsEtagTracker {
  record(keyId: string, clientVersion: string, etag: string): boolean;
  invalidate(): void;
  forResponse(keyId: string, clientVersion: string): string | null;
}

export interface CodexModelsEtagTrackerOptions {
  maxEntries?: number;
}

interface TrackedEtag {
  etag: string;
  generation: number;
}

function trackerKey(keyId: string, clientVersion: string): string {
  return JSON.stringify([keyId, clientVersion]);
}

function boundedSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CODEX_MODELS_ETAG_MAX_ENTRIES;
  return Math.max(1, Math.floor(value));
}

export function createCodexModelsEtagTracker(
  options: CodexModelsEtagTrackerOptions = {},
): CodexModelsEtagTracker {
  const maxEntries = boundedSize(options.maxEntries);
  const entries = new Map<string, TrackedEtag>();
  let generation = 0;

  function syntheticEtag(keyId: string, clientVersion: string): string {
    const digest = createHash("sha256")
      .update(JSON.stringify([keyId, clientVersion, generation]))
      .digest("hex")
      .slice(0, 16);
    return `"helm-codex-stale-${generation}-${digest}"`;
  }

  function touch(id: string, entry: TrackedEtag): void {
    entries.delete(id);
    entries.set(id, entry);
  }

  return {
    record(keyId, clientVersion, etag) {
      const normalized = normalizeOpenAICodexClientVersion(clientVersion);
      if (normalized === null || keyId.length === 0 || etag.length === 0 || etag.length > 1_024) {
        return false;
      }
      const id = trackerKey(keyId, normalized);
      touch(id, { etag, generation });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return true;
    },

    invalidate() {
      if (generation >= Number.MAX_SAFE_INTEGER) {
        entries.clear();
        generation = 0;
      } else {
        generation += 1;
      }
    },

    forResponse(keyId, clientVersion) {
      const normalized = normalizeOpenAICodexClientVersion(clientVersion);
      if (normalized === null || keyId.length === 0) return null;
      const id = trackerKey(keyId, normalized);
      const entry = entries.get(id);
      if (!entry) return syntheticEtag(keyId, normalized);
      touch(id, entry);
      return entry.generation === generation ? entry.etag : syntheticEtag(keyId, normalized);
    },
  };
}
