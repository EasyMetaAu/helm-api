import type { CatalogEntry } from "@helm/shared";

// Capability Filter — a pure-function gate over a single Lane candidate.
//
// Lane hands an ordered candidate chain; not every candidate can satisfy this
// request's HARD constraints (tools / strict JSON / vision / context window /
// streaming). This module checks "can it?" — NOT "pick whom" (that's lane /
// policy). For each candidate it walks the gates in a fixed order; the first
// unmet gate short-circuits and returns a structured skip reason. That reason
// is written into the decision record's `provider_attempts[].skip_reason` so
// the debug UI can explain why a provider was skipped (docs/02 security rules).
//
// Framework-/network-/IO-free, deterministic: same input → same output
// (principle 1 + principle 4). Capability data comes solely from `catalog.sync`
// (the merged `CatalogEntry.capabilities`); this module never reads yaml nor
// talks to upstreams.

// Stable string union — contract for the decision record and debug UI. Adding a
// reason means updating this enum AND the UI; never slip in a free-form string.
export type SkipReason =
  | "no_tool_support" // request carries tools, candidate has no tool-call
  | "no_json_support" // request needs strict JSON, candidate has no JSON mode
  | "no_vision_support" // request has images/attachments, candidate is text-only
  | "context_too_small" // prompt(+max_tokens) exceeds candidate's window
  | "no_streaming_support" // request wants stream, candidate can't stream
  | "no_nonstream_support"; // request is non-stream, candidate is stream-ONLY (relay requires stream:true)

export interface CapabilityRequest {
  needsTools: boolean;
  needsJson: boolean; // response_format = JSON / lane.require_json
  needsVision: boolean; // has attachments / images
  needsStreaming: boolean; // request.stream === true
  estimatedPromptTokens: number;
  maxTokens: number | null; // client-requested output cap, counted in budget
}

export interface FilterResult {
  ok: boolean;
  skipReason: SkipReason | null; // non-null iff ok=false; null iff ok=true
}

const PASS: FilterResult = { ok: true, skipReason: null };

function skip(skipReason: SkipReason): FilterResult {
  return { ok: false, skipReason };
}

// Check a single candidate gate-by-gate; the first unmet gate returns its
// reason (short-circuit). All gates pass → { ok: true, skipReason: null }.
export function checkCapability(
  caps: CatalogEntry["capabilities"],
  req: CapabilityRequest,
): FilterResult {
  // 1. tools
  if (req.needsTools && !caps.supportsTools) {
    return skip("no_tool_support");
  }
  // 2. strict JSON
  if (req.needsJson && !caps.supportsJsonMode) {
    return skip("no_json_support");
  }
  // 3. vision
  if (req.needsVision && !caps.supportsVision) {
    return skip("no_vision_support");
  }
  // 4. context budget = input + planned output ≤ window (null maxTokens → 0).
  const outputBudget = req.maxTokens ?? 0;
  if (req.estimatedPromptTokens + outputBudget > caps.maxContextTokens) {
    return skip("context_too_small");
  }
  // 5. streaming
  if (req.needsStreaming && !caps.supportsStreaming) {
    return skip("no_streaming_support");
  }
  // 6. stream-ONLY candidate vs non-stream request. Some relays (la.atmy.work
  //    gpt-5.x) 400 a non-stream call ("Stream must be set to true"). Skipping
  //    here turns that guaranteed failure into a clean fail-over: the attempt is
  //    never made, so no breaker failure is recorded (a stream-only primary can
  //    no longer be tripped OPEN by non-stream traffic and then wrongly skipped
  //    for streaming traffic). Absent flag ⇒ false ⇒ not stream-only.
  if (!req.needsStreaming && caps.requiresStreaming === true) {
    return skip("no_nonstream_support");
  }
  // 7. all gates passed
  return PASS;
}
