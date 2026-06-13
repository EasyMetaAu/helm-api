import type { IRMessage } from "../protocol/ir.js";
import type { InjectInput, InjectResult } from "./inject.js";
import { sha256Hex } from "./message-hash.js";
import { serializeContent } from "./observe.js";

// docs/08 Phase 2 (#217 Phase 4 PREFIX model) — the framework-agnostic bridge
// between the inject assembler and the IR message array every request surface
// (chat / messages / responses) shares.
//
// THE PREFIX MODEL replaces the legacy full-replace compaction. The assembler no
// longer rebuilds the conversation into plain-text AssembledMessage[]; it produces
// ONE system-level memory TEXT BLOCK. The bridge's job is therefore purely
// ADDITIVE and structure-preserving:
//   1. WINDOW HASH — fingerprint the current request's live messages the SAME way
//      storage hashes them (sha256Hex(serializeContent(content))), so the assembler
//      can window-dedup thread observations whose covered turns the client still
//      sends. Computed HERE because the live IR window only exists at the request
//      surface (the assembler reads stored rows, not the live request).
//   2. ASSEMBLE — run the bound assembler with the window hashes + token budget.
//   3. MERGE — splice the memory block into the SYSTEM message (decision #3):
//      replace an existing leading system message's content, else PREPEND a new
//      one. EVERY other message (user / assistant / tool, incl. tool_calls and
//      multipart/image content) is kept VERBATIM and in order. No replacement of
//      live turns ⇒ no structure can be lost ⇒ the legacy D7 plain-text gate is
//      GONE: tool-using / multimodal / developer turns inject just like text turns.
//
// The raw `memoryBlock` is ALSO surfaced unchanged so the pipeline can splice it
// into a NATIVE passthrough request's system/instructions (P4-3) without re-running
// the assembler.
//
// Lives in core so it imports no web framework and is unit-testable directly.

export interface InjectBridgeDeps {
  // Bound assembler: assembleInjectedContext with its store/cost/log deps closed
  // over in the composition root. The bridge only supplies the per-request input
  // (scope + token budget + the live-window content hashes it computes).
  assemble: (input: InjectInput) => Promise<InjectResult>;
  // Bound write-back enqueue (enqueueObserverWriteback with its deps closed over).
  // The assembler ALREADY enqueues write-back on every path it completes (success
  // AND degraded-load), so this is called ONLY from the bridge's fail-open catch
  // (the assembler THREW before it could enqueue) — preserving the "write-back
  // always fires for every turn" guarantee even when assembly explodes.
  enqueueObserver: (
    scope: InjectInput["scope"],
  ) => Promise<{ observerJobId: string | null; status: "queued" | "skipped" | "failed" }>;
  // Upper bound for injected memory tokens (D9). The block alone is capped here.
  tokenBudget: number;
  now: () => Date;
  log: (line: string, meta?: object) => void;
}

export interface InjectBridgeResult {
  // The IR messages to route with. Under the PREFIX model this is the live
  // conversation with the memory block MERGED into the system message (verbatim
  // user/assistant/tool turns preserved); when there is nothing to inject it is the
  // ORIGINAL array reference, untouched. The pipeline assigns this to the TRANSLATE
  // path's request; the NATIVE passthrough path uses `memoryBlock` directly.
  messages: IRMessage[];
  // The assembled memory TEXT BLOCK (system-level). null when there is nothing to
  // inject / inject was skipped / failed — the pipeline then leaves native
  // system/instructions untouched.
  memoryBlock: string | null;
  // The assembler metadata when inject ran (success OR degraded); null only when
  // the assembler THREW (so the caller stamps telemetry only on a real attempt).
  metadata: InjectResult["metadata"] | null;
}

// Fingerprint the current request's live messages as the dedup WINDOW. Each hash is
// sha256Hex(serializeContent(content)) — byte-identical to how observe.ts persisted
// the turn's content_hash — so a stored thread observation whose covered turns are
// all still in this window is recognized as redundant by the assembler (the client
// re-sends them verbatim; injecting the summary too would duplicate). Roles that
// storage drops (system/developer) are still hashed; extra entries are harmless
// (they can only collide with genuinely identical content) and keep this a pure,
// allocation-cheap projection of the request.
function windowContentHashes(messages: IRMessage[]): Set<string> {
  const hashes = new Set<string>();
  for (const m of messages) {
    hashes.add(sha256Hex(serializeContent(m.content)));
  }
  return hashes;
}

// Merge the memory block into the SYSTEM message (decision #3). If the conversation
// already opens with a system message, prepend the block to its content with a blank
// line separator; otherwise splice a NEW leading system message carrying the block.
// Returns a NEW array — the input array and its messages are never mutated. All
// non-system (and trailing) messages are kept by reference, in order, VERBATIM.
function mergeMemoryIntoSystem(messages: IRMessage[], memoryBlock: string): IRMessage[] {
  const leading = messages[0];
  if (leading?.role === "system") {
    const original =
      typeof leading.content === "string"
        ? leading.content
        : // A non-string system content (rare; multipart) — keep memory first as
          // text and re-serialize the original alongside, never dropping it.
          serializeContent(leading.content);
    const mergedSystem: IRMessage = {
      ...leading,
      content: original.length > 0 ? `${memoryBlock}\n\n${original}` : memoryBlock,
    };
    return [mergedSystem, ...messages.slice(1)];
  }
  return [{ role: "system", content: memoryBlock }, ...messages];
}

// Run the inject phase and return the IR messages to route with (memory merged at
// the system level) + the raw memory block + assembler metadata. The PREFIX model
// keeps the live conversation VERBATIM — memory is additive at the system level,
// never a replacement — so this never destroys tool_calls / images / tool results,
// and the legacy D7 plain-text gate is no longer needed.
//
// FAIL-OPEN (principle 3): a degraded assembler result returns the ORIGINAL messages
// + null block + the metadata; an assembler THROW returns the original messages +
// null block + null metadata AND enqueues write-back directly (the assembler never
// got to enqueue), so the turn is still queued for compression. Inject never 5xx's
// and never alters routing.
//
// `systemPrompt` is the leading system content the caller already extracted; it is
// retained for parity with the call sites and as a stable contract, but the merge
// reads the system message off `messages[0]` directly (single source of truth), so
// the parameter is currently informational only.
export async function injectIntoIR(
  messages: IRMessage[],
  systemPrompt: string,
  scope: InjectInput["scope"],
  deps: InjectBridgeDeps,
): Promise<InjectBridgeResult> {
  void systemPrompt;
  try {
    const result = await deps.assemble({
      scope,
      tokenBudget: deps.tokenBudget,
      windowContentHashes: windowContentHashes(messages),
    });

    // Nothing to inject (no memory) or a degraded load: keep the live conversation
    // exactly as-is. The assembler already enqueued write-back on both paths.
    if (result.memoryBlock === null) {
      return { messages, memoryBlock: null, metadata: result.metadata };
    }

    // Splice the block at the system level; the live turns stay verbatim.
    return {
      messages: mergeMemoryIntoSystem(messages, result.memoryBlock),
      memoryBlock: result.memoryBlock,
      metadata: result.metadata,
    };
  } catch (err) {
    deps.log("memory.inject.bridge_failed", {
      scope,
      error: err instanceof Error ? err.message : String(err),
    });
    // The assembler threw BEFORE it could enqueue write-back. Preserve the
    // "write-back always fires" guarantee by enqueuing here — itself best-effort
    // (enqueueObserver is fail-open and never throws, but guard anyway so a buggy
    // dep can never break fail-open).
    try {
      await deps.enqueueObserver(scope);
    } catch (enqueueErr) {
      deps.log("memory.inject.bridge_writeback_failed", {
        scope,
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      });
    }
    return { messages, memoryBlock: null, metadata: null };
  }
}
