import type { IRMessage } from "../protocol/ir.js";
import type { InjectInput, InjectResult } from "./inject.js";
import { sha256Hex } from "./message-hash.js";
import { serializeContent } from "./observe.js";

// docs/08 Phase 2 (#217 Phase 4 TRAILING-REMINDER model) — the framework-agnostic
// bridge between the inject assembler and the IR message array every request surface
// (chat / messages / responses) shares.
//
// THE TRAILING-REMINDER MODEL replaces the legacy full-replace compaction AND the
// short-lived system-PREFIX merge. The assembler produces ONE memory TEXT BLOCK; the
// bridge's job is purely ADDITIVE and structure-preserving:
//   1. WINDOW HASH — fingerprint the current request's live messages the SAME way
//      storage hashes them (sha256Hex(serializeContent(content))), so the assembler
//      can window-dedup thread observations whose covered turns the client still
//      sends. Computed HERE because the live IR window only exists at the request
//      surface (the assembler reads stored rows, not the live request).
//   2. ASSEMBLE — run the bound assembler with the window hashes + token budget.
//   3. APPEND — splice the memory block as ONE trailing `<system-reminder>` user turn
//      AFTER the verbatim conversation. EVERY existing message (system / user /
//      assistant / tool, incl. tool_calls and multipart/image content) is kept VERBATIM
//      and in order — including the LEADING system message, which is left byte-identical
//      so any client `cache_control` on it (and the whole upstream cache prefix
//      tools → system → history) survives. No replacement of live turns ⇒ no structure
//      can be lost ⇒ the legacy D7 plain-text gate is GONE.
//
//      WHY TRAILING, not system-PREFIX (cache-preserve revision of decision #3): prompt
//      caching is a strict prefix match (tools → system → messages). Prepending memory
//      into `system` shifts the client's cached prefix and busts it every memory-mode
//      turn — and the memory block is itself window-variable, so it can never settle in
//      a cached prefix. Appending memory AFTER the cached prefix leaves the cache intact;
//      only the small reminder turn is uncached. The `<system-reminder>` wrapper keeps
//      system-AUTHORITY framing (Claude is trained to treat it as injected operator
//      context, not the user speaking) without needing a model-gated beta.
//
// The raw `memoryBlock` is ALSO surfaced unchanged so the pipeline can splice it
// into a NATIVE passthrough request's messages/input (P4-3) without re-running the
// assembler.
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

// Wrap the assembled memory block in a `<system-reminder>` envelope — the single
// source of truth for the injected text on BOTH the translate path (the trailing IR
// user turn below) and the native passthrough path (the gateway splices the SAME
// wrapped text into the native carrier). The envelope gives the block system-AUTHORITY
// framing (Claude is trained to read `<system-reminder>` as injected operator context,
// not as the user speaking) without a model-gated beta header. Pure + deterministic so
// the text is byte-stable for a given block.
export function wrapMemoryReminder(memoryBlock: string): string {
  return `<system-reminder>\n${memoryBlock}\n</system-reminder>`;
}

// Append the memory block as ONE trailing `<system-reminder>` user turn AFTER the
// verbatim conversation. The leading system message (and any client cache_control on
// it) and EVERY existing turn are kept by reference, in order — the upstream prompt-cache
// prefix (tools → system → history) is left byte-identical, so only the small reminder
// turn is uncached. Returns a NEW array; the input array and its messages are never
// mutated.
function appendMemoryReminder(messages: IRMessage[], memoryBlock: string): IRMessage[] {
  return [...messages, { role: "user", content: wrapMemoryReminder(memoryBlock) }];
}

// Run the inject phase and return the IR messages to route with (memory appended as a
// trailing `<system-reminder>` turn) + the raw memory block + assembler metadata. The
// trailing-reminder model keeps the live conversation VERBATIM — memory is additive at
// the END, never a replacement — so this never destroys tool_calls / images / tool
// results, never disturbs the client's cached prefix, and the legacy D7 plain-text gate
// is no longer needed.
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

    // Append the block as a trailing <system-reminder> turn; the live turns (and the
    // client's cached system prefix) stay verbatim.
    return {
      messages: appendMemoryReminder(messages, result.memoryBlock),
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
