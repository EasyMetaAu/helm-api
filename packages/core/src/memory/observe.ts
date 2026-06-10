import { type MemoryMessageInput, MemoryModeSchema, type MemoryRole } from "@helm/shared";
import type { IRMessage } from "../protocol/ir.js";
import type { MemoryStore } from "../store/ports.js";
import type { MemoryMeta, MemoryScope } from "./types.js";

// observe mode (docs/08 Phase 1). Persists raw request/response/tool messages into
// the memory_* tables but NEVER injects memory or changes routing — observe is a
// write-only middleware. Framework-agnostic: this module receives an already
// resolved MemoryScope (the gateway parses the HTTP headers); it imports no web
// framework (CLAUDE.md principle 1). Persistence is fail-open: a store failure
// degrades to "continue without memory" + a logged failure, never a 5xx
// (CLAUDE.md principle 3; docs/08 "if memory load fails, the main request must continue without memory").

// A tool result in the IR is just an IRMessage with role="tool" (carrying
// tool_call_id). Aliased for a readable outbound contract.
export type IRToolResult = IRMessage;

export interface ObserveDeps {
  memoryStore: MemoryStore;
  now: () => Date;
  estimateTokens: (text: string) => number;
  // Structured logger; callers thread trace_id through meta. Must not log full
  // memory content verbatim (docs/08 full memory requires explicit authorization and auditing).
  log: (line: string, meta?: object) => void;
}

// IR roles that the memory layer persists. System/developer instructions are
// execution policy, not user memory; they must not enter long-term memory or be
// reflected back as ordinary context.
function toMemoryRole(role: IRMessage["role"]): MemoryRole | null {
  switch (role) {
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    case "user":
      return "user";
    default:
      return null;
  }
}

// Serialize IR content (string | multipart parts | null) to the raw string the
// memory_messages.content column stores. Multipart is JSON-stringified so it is
// auditable against the original (docs/08 raw message persistence).
function serializeContent(content: IRMessage["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

// Map IR messages to the rows we persist: drop system/developer turns (execution
// policy, not memory), serialize content, estimate tokens. Shared by inbound +
// outbound so both build one batch with identical filtering.
function toMessageInputs(
  messages: IRMessage[],
  threadId: string,
  estimateTokens: (text: string) => number,
): MemoryMessageInput[] {
  const inputs: MemoryMessageInput[] = [];
  for (const message of messages) {
    const role = toMemoryRole(message.role);
    if (role === null) continue;
    const content = serializeContent(message.content);
    inputs.push({ threadId, role, content, tokenEstimate: estimateTokens(content) });
  }
  return inputs;
}

// Persist a turn's messages in ONE commit via the batch path when the store
// supports it; otherwise fall back to the per-message loop so stores/fakes that
// predate appendMessages keep working. Empty input is a no-op. The INBOUND caller
// runs this BEFORE the upstream request, so collapsing N synchronous commits into
// one is a direct latency win on every turn (CLAUDE.md principle 1: framework-free).
async function persistMessages(store: MemoryStore, inputs: MemoryMessageInput[]): Promise<void> {
  if (inputs.length === 0) return;
  if (store.appendMessages) {
    await store.appendMessages(inputs);
    return;
  }
  for (const input of inputs) await store.appendMessage(input);
}

export function ownerScopedThreadId(accountId: string, threadId: string): string {
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(threadId)}`;
}

function storageThreadId(scope: Pick<MemoryScope, "accountId" | "threadId">): string | null {
  return scope.threadId === null ? null : ownerScopedThreadId(scope.accountId, scope.threadId);
}

function memoryMeta(scope: MemoryScope): MemoryMeta {
  // observe NEVER hydrates — memory_hydrated is always false and every
  // inject-phase counter stays at its null/zero default (docs/08 debug-UI field).
  return {
    memory_mode: scope.mode,
    thread_id: scope.threadId,
    resource_id: scope.resourceId,
    project_id: scope.projectId,
    memory_hydrated: false,
    reflection_version: null,
    observation_count: 0,
    memory_tokens_injected: 0,
    observer_job_id: null,
    memory_writeback_status: null,
  };
}

// Inbound: on observe/inject, persist the current request's raw messages. On off
// it is a pure no-op. Returns whether anything was persisted + the request-log
// metadata — NEVER an injectable prompt (observe does not inject).
export async function observeInbound(
  deps: ObserveDeps,
  scope: MemoryScope,
  messages: IRMessage[],
): Promise<{ persisted: boolean; memoryMeta: MemoryMeta }> {
  const meta = memoryMeta(scope);
  // off: zero DB touch, zero routing change.
  if (scope.mode === "off") {
    return { persisted: false, memoryMeta: meta };
  }
  // observe requires a thread scope; without one there is nothing to attach
  // messages to — degrade to no-op rather than fabricating an id.
  if (scope.threadId === null) {
    deps.log("memory.observe.skip_no_thread", { memory_mode: scope.mode });
    return { persisted: false, memoryMeta: meta };
  }

  const threadId = storageThreadId(scope);
  if (threadId === null) return { persisted: false, memoryMeta: meta };

  try {
    await deps.memoryStore.ensureThread({
      id: threadId,
      ownerId: scope.accountId,
      ...(scope.projectId !== null ? { projectId: scope.projectId } : {}),
      ...(scope.resourceId !== null ? { resourceId: scope.resourceId } : {}),
    });
    await persistMessages(
      deps.memoryStore,
      toMessageInputs(messages, threadId, deps.estimateTokens),
    );
    return { persisted: true, memoryMeta: meta };
  } catch (err) {
    // fail-open: never throw to the main request path; record + continue.
    deps.log("memory.observe.inbound_failed", {
      memory_mode: scope.mode,
      thread_id: scope.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { persisted: false, memoryMeta: meta };
  }
}

// Outbound: on observe/inject, persist the response messages + tool results. off
// is a no-op. Fail-open — a store failure is logged, never thrown. observe does
// NOT enqueue an observer job (that is docs/08 Phase 2).
//
// `servedModel` is the alias that ACTUALLY handled this turn (known only post-
// route, so it cannot be set at inject time). We stamp it onto the thread so the
// background observer can price its auto-compaction ledger from the catalog. The
// stamp is its own best-effort try/catch (a stamp failure must not lose the
// response messages); the whole method stays fail-open.
export async function observeOutbound(
  deps: ObserveDeps,
  scope: MemoryScope,
  result: { responseMessages: IRMessage[]; toolResults: IRToolResult[] },
  servedModel?: string | null,
): Promise<void> {
  if (scope.mode === "off") return;
  const threadId = storageThreadId(scope);
  if (threadId === null) return;

  try {
    await persistMessages(
      deps.memoryStore,
      toMessageInputs(
        [...result.responseMessages, ...result.toolResults],
        threadId,
        deps.estimateTokens,
      ),
    );
  } catch (err) {
    deps.log("memory.observe.outbound_failed", {
      memory_mode: scope.mode,
      thread_id: threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Stamp the served model (auto-compaction price resolution). Separate guard:
  // independent of message persistence, and the store method is optional (a
  // pre-phase store simply skips it).
  if (servedModel != null && servedModel !== "" && deps.memoryStore.stampThreadModel) {
    try {
      await deps.memoryStore.stampThreadModel({
        accountId: scope.accountId,
        threadId,
        modelAlias: servedModel,
      });
    } catch (err) {
      deps.log("memory.observe.stamp_model_failed", {
        thread_id: threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Gateway boundary helper: normalize a raw x-memory-mode header value to a legal
// MemoryMode. Missing / illegal / wrong-case values fail safe to "off" (docs/08
// default x-memory-mode = off; default-safe). Kept here so the gateway adapter has
// one source of truth without importing a web framework into core.
export function resolveMemoryMode(raw: string | null | undefined): MemoryScope["mode"] {
  const parsed = MemoryModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : "off";
}
