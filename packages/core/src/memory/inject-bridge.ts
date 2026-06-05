import { randomUUID } from "node:crypto";
import type { AssembledMessage, RawMessage } from "@helm/shared";
import type { IRMessage } from "../protocol/ir.js";
import type { InjectInput, InjectResult } from "./inject.js";

// docs/08 Phase 2 — the framework-agnostic bridge between the inject assembler and
// the IR message array every request surface (chat / messages / responses) shares.
// It owns the lossy-risk decisions so the gateway routes stay thin glue:
//   D7  — the PLAIN-TEXT gate: full-replace is only safe when the turn carries no
//         tool_calls and no structured/multipart content (the AssembledMessage
//         role enum is user|assistant|tool with NO tool_calls field, so replacing
//         a tool-using turn would silently drop the tool call). Tool/structured
//         turns skip the replace entirely.
//   D8  — synthesize a Zod-valid RawMessage for the current turn, call the
//         assembler, then map the assembled prefix BACK to IR: source==="system"
//         restores a role=system IR message; every other source keeps its role and
//         drops the source tag — STRICT order preserved (the source enum order is
//         load-bearing).
// Lives in core so it imports no web framework and is unit-testable directly.

// D7 gate. A turn is "plain text" iff EVERY message is a string-content user/
// assistant/system message with no tool_calls, no tool role, and no developer
// instructions. The inject assembler can only rebuild user/assistant/system;
// developer is a first-class instruction tier, so replacing would silently drop it.
export function isPlainTextTurn(messages: IRMessage[]): boolean {
  for (const m of messages) {
    if (m.role === "developer" || m.role === "tool") return false;
    if (m.tool_calls !== undefined && m.tool_calls.length > 0) return false;
    // content must be a plain string (or null) — an array is multipart/structured.
    if (m.content !== null && typeof m.content !== "string") return false;
  }
  return true;
}

export interface InjectBridgeDeps {
  // Bound assembler: assembleInjectedContext with its store/cost/log deps closed
  // over in the composition root. The bridge only supplies the per-request input.
  assemble: (input: InjectInput) => Promise<InjectResult>;
  // Bound write-back enqueue (enqueueObserverWriteback with its deps closed over).
  // Called DIRECTLY when the D7 gate skips assembly — a tool/multipart turn must
  // still enqueue its observer job or tool-heavy threads never compress.
  enqueueObserver: (
    scope: InjectInput["scope"],
  ) => Promise<{ observerJobId: string | null; status: "queued" | "skipped" | "failed" }>;
  // Upper bound for injected memory tokens (D9). System + current are excluded.
  tokenBudget: number;
  now: () => Date;
  log: (line: string, meta?: object) => void;
}

export interface InjectBridgeResult {
  // The IR messages to route with — either the assembled prefix (success) or the
  // ORIGINAL array unchanged (fail-open / skip).
  messages: IRMessage[];
  // The assembler metadata when inject ran; null when it was skipped or failed
  // (so the caller can stamp telemetry only on a real hydrate).
  metadata: InjectResult["metadata"] | null;
}

// Placeholder threadId when the scope has none — RawMessageSchema requires
// threadId.min(1), but inject only ever reads role/content off this message, so a
// stable placeholder satisfies the Zod boundary without affecting behavior.
const NO_THREAD_PLACEHOLDER = "<inject-no-thread>";

// Map ONE assembled message back to an IR message, restoring the system layer.
function assembledToIR(m: AssembledMessage): IRMessage {
  if (m.source === "system") {
    return { role: "system", content: m.content };
  }
  return { role: m.role, content: m.content };
}

// Run the inject phase and return the assembled IR prefix. The bridge OWNS the
// D7 gate: a non-plain-text turn keeps its original messages (replacement would
// drop tool calls / structured content) but STILL enqueues the observer
// write-back so the thread keeps compressing — the gate guards the replace, not
// the write-back. FAIL-OPEN: any throw returns the original messages + null
// metadata so the caller routes WITHOUT memory — inject never 5xx's and never
// alters routing (principle 3).
export async function injectIntoIR(
  messages: IRMessage[],
  systemPrompt: string,
  scope: InjectInput["scope"],
  deps: InjectBridgeDeps,
): Promise<InjectBridgeResult> {
  try {
    if (!isPlainTextTurn(messages)) {
      const writeback = await deps.enqueueObserver(scope);
      deps.log("memory.inject.skipped_non_plain_text", {
        scope,
        writeback_status: writeback.status,
        observer_job_id: writeback.observerJobId,
      });
      return { messages, metadata: null };
    }

    const last = messages[messages.length - 1];
    const content = typeof last?.content === "string" ? last.content : "";
    const role: RawMessage["role"] =
      last?.role === "assistant" || last?.role === "tool" ? last.role : "user";
    const currentUserMessage: RawMessage = {
      id: randomUUID(),
      threadId: scope.threadId ?? NO_THREAD_PLACEHOLDER,
      role,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      createdAt: deps.now(),
    };

    const result = await deps.assemble({
      scope,
      currentUserMessage,
      systemPrompt,
      tokenBudget: deps.tokenBudget,
    });

    if (result.metadata.degraded) {
      return { messages, metadata: result.metadata };
    }

    return { messages: result.messages.map(assembledToIR), metadata: result.metadata };
  } catch (err) {
    deps.log("memory.inject.bridge_failed", {
      scope,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages, metadata: null };
  }
}
