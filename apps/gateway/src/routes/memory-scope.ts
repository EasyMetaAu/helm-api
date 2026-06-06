import { type MemoryScope, resolveMemoryMode } from "@helm/core";
import type { MemoryMode, MemoryThreadSource } from "@helm/shared";

// Memory request-header boundary (docs/08 + issue #97). The gateway parses the
// four memory headers HERE — packages/core never touches HTTP (CLAUDE.md
// principle 1) — and hands a resolved MemoryScope to observe/inject. Pure over a
// `headerGet` function so it works for BOTH the OpenAI surface (Hono
// `c.req.header`) and the Anthropic surface (an IR-metadata getter), with one
// parse path / one set of defaults.
//
// Issue #97 adds two ZERO-CLIENT-CHANGE inputs, both inert unless configured:
//   • per-key DEFAULTS (memory_mode / memory_project_id / memory_thread_source,
//     stored on the API key) fill in absent headers — explicit headers always win;
//   • a thread-signal FALLBACK CHAIN derives the thread anchor from signals the
//     client already sends (body metadata, x-session-key, OpenAI prompt_cache_key,
//     Anthropic metadata.user_id) — gated behind memory_thread_source === "auto".
// Memory is ON by default: absent a header and a per-key default, mode resolves
// to "inject". An explicit x-memory-mode (incl. "off") or a stored key default
// still wins. Real authed traffic always carries the key's stored mode, so this
// bare fallback only governs the no-key-config path.

// An absent header OR an empty string yields null — an empty x-thread-id must
// never fabricate a thread id (observe self-gates to a no-op on threadId===null).
function nonEmpty(value: string | undefined | null): string | null {
  return value !== undefined && value !== null && value.length > 0 ? value : null;
}

// Per-key memory defaults, threaded from the resolved ApiKeyRecord by each
// route's auth identity (snake_case columns → this camelCase view).
export interface MemoryKeyDefaults {
  mode: MemoryMode;
  projectId: string | null;
  threadSource: MemoryThreadSource;
}

// Body-derived thread signals the ROUTE extracts before calling the resolver
// (the resolver never parses a body itself). All best-effort: absent/empty are
// ignored. The x-session-key header is read internally via headerGet.
export interface MemoryThreadSignals {
  // Body metadata.thread_id / conversation_id (any surface).
  metadataThreadId?: string | null;
  // OpenAI chat / Responses body `prompt_cache_key` — the per-conversation cache
  // affinity key OpenClaw and Codex already send.
  promptCacheKey?: string | null;
  // Anthropic body `metadata.user_id` — the session-stable hash Claude Code and
  // OpenClaw already send.
  metadataUserId?: string | null;
}

// Which link of the chain produced the thread anchor (observability: stamped
// into DecisionRecord.memory.thread_source + logs). null = no thread resolved.
export type ResolvedThreadSource =
  | "header"
  | "metadata_thread_id"
  | "session_key"
  | "prompt_cache_key"
  | "metadata_user_id";

export interface ResolvedMemoryScope extends MemoryScope {
  threadSource: ResolvedThreadSource | null;
}

// Resolve the memory scope from a header-getter (name → value | undefined), the
// key's stored defaults, and the route-extracted body signals. The getter
// mirrors Hono's `c.req.header(name)` contract so the same function serves the
// IR-metadata path on the Anthropic surface too.
export function resolveMemoryScope(
  headerGet: (name: string) => string | undefined,
  accountId: string,
  opts?: { defaults?: MemoryKeyDefaults; signals?: MemoryThreadSignals },
): ResolvedMemoryScope {
  const defaults = opts?.defaults;

  // Mode: an explicit, non-empty x-memory-mode header always wins — including
  // "off" overriding a key default of inject, and an ILLEGAL value normalizing
  // to off (fail-safe: a typo must never silently inherit a more permissive
  // mode). Absent header → the key default → "inject" (memory is on by default).
  const modeHeader = nonEmpty(headerGet("x-memory-mode"));
  const mode = modeHeader !== null ? resolveMemoryMode(modeHeader) : (defaults?.mode ?? "inject");

  // Project: header wins; else the key default.
  const projectId = nonEmpty(headerGet("x-project-id")) ?? defaults?.projectId ?? null;

  // Thread: explicit header first; the signal chain ONLY when the key opted in
  // via memory_thread_source = "auto" (default "header" keeps pre-#97 behavior).
  // PRESENCE matters: an explicitly PRESENT x-thread-id — even empty "" — is an
  // intentional opt-out of derivation (folds to null, chain NOT run), distinct
  // from an ABSENT header (chain runs). This lets a caller disable auto thread
  // derivation per request without turning memory off entirely.
  const threadHeaderPresent = headerGet("x-thread-id") !== undefined;
  let threadId = nonEmpty(headerGet("x-thread-id"));
  let threadSource: ResolvedThreadSource | null = threadId !== null ? "header" : null;
  if (!threadHeaderPresent && defaults?.threadSource === "auto") {
    const chain: Array<[ResolvedThreadSource, string | null]> = [
      ["metadata_thread_id", nonEmpty(opts?.signals?.metadataThreadId)],
      ["session_key", nonEmpty(headerGet("x-session-key"))],
      ["prompt_cache_key", nonEmpty(opts?.signals?.promptCacheKey)],
      ["metadata_user_id", nonEmpty(opts?.signals?.metadataUserId)],
    ];
    for (const [source, value] of chain) {
      if (value !== null) {
        threadId = value;
        threadSource = source;
        break;
      }
    }
  }

  return {
    accountId,
    threadId,
    resourceId: nonEmpty(headerGet("x-resource-id")),
    projectId,
    mode,
    threadSource,
  };
}
