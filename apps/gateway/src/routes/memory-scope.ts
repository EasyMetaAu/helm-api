import { type MemoryScope, resolveMemoryMode } from "@helm/core";

// Memory request-header boundary (docs/08). The gateway parses the four memory
// headers HERE — packages/core never touches HTTP (CLAUDE.md principle 1) — and
// hands a resolved MemoryScope to observe/inject. Pure over a `headerGet`
// function so it works for BOTH the OpenAI surface (Hono `c.req.header`) and the
// Anthropic surface (an IR-metadata getter), with one parse path / one set of
// defaults. Mode normalization is delegated to core's resolveMemoryMode (the
// single source of truth); an absent/illegal x-memory-mode → "off" (default-safe).

// An absent header OR an empty string yields null — an empty x-thread-id must
// never fabricate a thread id (observe self-gates to a no-op on threadId===null).
function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

// Resolve the memory scope from a header-getter (name → value | undefined). The
// getter mirrors Hono's `c.req.header(name)` contract so the same function serves
// the IR-metadata path on the Anthropic surface too.
export function resolveMemoryScope(headerGet: (name: string) => string | undefined): MemoryScope {
  return {
    threadId: nonEmpty(headerGet("x-thread-id")),
    resourceId: nonEmpty(headerGet("x-resource-id")),
    projectId: nonEmpty(headerGet("x-project-id")),
    mode: resolveMemoryMode(headerGet("x-memory-mode")),
  };
}
