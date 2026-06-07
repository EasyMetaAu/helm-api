import { type ReflectionScope, ReflectionScopeSchema } from "./schema.js";

// D1 — canonical scope_id encoding. memory_jobs.scope_id is a single TEXT column,
// but a job's ReflectionScope has up to three optional levels. We serialize it to
// canonical JSON with a STABLE key order and undefined levels OMITTED, so:
//   - the SAME scope always yields the SAME string → dedupe by scope_id works,
//   - it decodes back losslessly even when ids contain separator/JSON characters
//     (a delimiter-joined string would be ambiguous the moment an id holds the
//     delimiter — JSON never is).
// Kept in @helm/shared so BOTH the sqlite and postgres adapters encode identically.

const ORDER = ["accountId", "projectId", "resourceId", "threadId", "trigger"] as const;

export function encodeScopeId(scope: ReflectionScope): string {
  const canonical: Record<string, string> = {};
  for (const key of ORDER) {
    const value = scope[key];
    if (value !== undefined) canonical[key] = value;
  }
  return JSON.stringify(canonical);
}

export function decodeScopeId(scopeId: string): ReflectionScope {
  // Parse defensively, then re-validate through the schema so a corrupt row can
  // never inject a malformed scope into a worker (fail-closed at the boundary).
  const raw: unknown = JSON.parse(scopeId);
  return ReflectionScopeSchema.parse(raw);
}
