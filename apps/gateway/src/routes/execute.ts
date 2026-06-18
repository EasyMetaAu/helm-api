import type {
  CircuitBreaker,
  ExecuteOutcome,
  ExecutionPlan,
  ProviderClient,
  ProviderRegistry,
  RouteProviderAttempt,
} from "@helm/core";
import {
  anthropicNativeBodyRequiresSystemFold,
  applyForcedReasoningToNativeBody,
  canUseNativePassthrough,
  checkCapability,
  type NativePassthroughDisableReason,
  openaiTransformer,
  resolveCostUsd,
  UpstreamError,
} from "@helm/core";
import type {
  AttemptErrorDetail,
  CatalogEntry,
  InternalRequest,
  NativePassthroughCarrier,
  Protocol,
  TargetProviderProtocol,
} from "@helm/shared";
import {
  appendMutationList,
  cloneCarrierWithBody,
  isNativePassthroughCarrier,
  makeHelmError,
  nativePassthroughBody,
  nativePassthroughMutations,
} from "@helm/shared";
import {
  usageFromAnthropicResponse,
  usageFromGeminiResponse,
  usageFromResponsesResponse,
} from "./payload-capture.js";

// Gateway execution adapter — the `execute` injected into routeRequest. It walks
// the resolved candidate chain (ExecutionPlan.candidate_chain) honoring the
// EXECUTION-fallback rules (CLAUDE.md principle 5, docs/04):
//   resolve alias (registry) -> pick the RESOLVED provider's client (so a chain
//   can CROSS providers) -> circuit breaker gate (OPEN => skip) -> capability
//   filter (incompatible => skip) -> provider invoke. First success wins;
//   failures BEFORE the first valid chunk record a breaker failure and try the
//   next candidate; a client abort is a NON-provider fault (no breaker failure,
//   terminates the chain); chain exhaustion => structured `all_providers_failed`.
//
// Multi-provider (providers-multi): each candidate alias resolves (via registry)
// to a provider name + upstream model id. The executor invokes THAT provider's
// client — so a fallback chain like [deepseek/.., openai/..] hits two different
// upstreams in order. Unknown aliases still fall back to `defaultProvider` for
// Phase-0 passthrough; a resolved provider with no registered client is skipped
// fail-closed, never silently served with another provider's credential.
//
// Streaming (principle 8): for stream:true the provider stream is forwarded
// UNBUFFERED. We peek the FIRST chunk to decide success vs. pre-first-chunk
// failure (matching the breaker contract), then hand back a generator that
// re-emits that first chunk followed by the rest — byte-for-byte, in order.

interface ProviderProtocolMetadata {
  targetProviderProtocol: TargetProviderProtocol;
  providerRequiresCompatibilityRewrite: boolean;
}

export interface ExecuteAdapterDeps {
  /** Default/fallback provider client: used only for unknown aliases
   *  (Phase-0 single-provider passthrough). */
  defaultProvider: ProviderClient;
  /** Per-provider clients keyed by provider NAME (registry providerName). When a
   *  candidate resolves to one of these, its client is used -> chains cross
   *  providers. Missing clients fail closed; defaultProvider is only for unknown
   *  aliases in Phase-0 passthrough. */
  providers?: Map<string, ProviderClient>;
  registry: ProviderRegistry;
  /** Known OAuth subscription provider IDs (ROUTABLE_OAUTH keys). An alias whose
   *  `<prefix>/` is one of these is a SUBSCRIPTION alias and is gated authoritatively
   *  by `oauthAliases` below — it must NEVER fall through to the registry or
   *  defaultProvider (that would cross subscription/credential boundaries). Absent →
   *  the gate is off (back-compat for tests that don't wire OAuth). */
  knownOAuthPrefixes?: ReadonlySet<string>;
  /** LIVE set of currently-exposed (curated) OAuth `<provider>/<model>` aliases,
   *  re-read per request so a Manage-dialog curation removal / disconnect takes
   *  effect immediately: a subscription alias NOT in this set fails CLOSED
   *  (provider_unavailable), never routes stale. Rebuilt alongside the pool. */
  oauthAliases?: () => ReadonlySet<string>;
  /** Provider protocol metadata for OAuth subscription prefixes, keyed by provider id
   *  (native protocol passthrough, issue #217). The OAuth pool aliases never reach the
   *  registry, so the executor needs the prefix→protocol map here to know an
   *  Anthropic-subscription alias forwards on the `anthropic_messages` wire. Absent →
   *  the metadata defaults to `openai_chat`/no-rewrite (back-compat for tests that
   *  don't wire OAuth protocols → passthrough is `protocol_mismatch`-disabled). */
  oauthProviderProtocols?: ReadonlyMap<string, ProviderProtocolMetadata>;
  breaker: CircuitBreaker;
  /** modelKey -> capabilities; missing entry => capability filter is skipped. */
  catalog: Map<string, CatalogEntry>;
  now: () => number;
  /** Abort signal for the current request (client disconnect). */
  signal: AbortSignal;
  /** Structured log sink (safe fields only — NEVER key/payload, principle 7).
   *  Optional: used to record a MISSING-pricing miss (cost left null, not a
   *  crash). Absent → the miss is silent. */
  log?: (level: string, msg: string, fields: Record<string, unknown>) => void;
  /** Runtime feature flag `native_protocol_passthrough` (default ON since #232). Read
   *  per attempt for live rollback: when true (and the guard passes) the executor
   *  forwards the verbatim native body and returns the native response untranslated.
   *  This dep is OPTIONAL: when absent (a caller that never wires it) the executor treats
   *  passthrough as OFF — a defensive fallback, independent of the setting's own default. */
  nativeProtocolPassthroughEnabled?: () => boolean;
  /** Auto-park hook (OAuth usage limit). Fired when a SUBSCRIPTION alias's attempt
   *  fails pre-first-chunk with a genuine (non-`:free`) upstream 429 — the served
   *  account just hit its rate/usage limit. The gateway reads WHICH account served
   *  (serving-account ALS) and parks it briefly so the pool routes around it. Absent
   *  → no auto-park (back-compat for tests / non-OAuth callers). The precise long
   *  cooldown for Codex/Anthropic still arrives via the quota-window capture path. */
  onOAuthSubscription429?: (alias: string) => void;
}

interface ResolvedAttemptTarget {
  provider: ProviderClient | undefined;
  providerName: string | null;
  providerModel: string;
  targetProviderProtocol: TargetProviderProtocol;
  providerRequiresCompatibilityRewrite: boolean;
}

// Per-attempt native-protocol-passthrough telemetry (issue #217), field-for-field
// aligned with @helm/shared ProviderAttemptSchema. Body-free (principle 7): protocol
// and provider metadata only, never request/response content. Spread onto EVERY
// attempts.push so the trail is uniform; the skip/abort/queue-timeout/free-429/generic
// rows use the default (considered:false), and the genuinely-evaluated rows (served-ok
// and the genuine-failure row) carry the real decision.
interface PassthroughTelemetry {
  passthrough_considered: boolean;
  passthrough_used: boolean;
  passthrough_disable_reason: NativePassthroughDisableReason | null;
  source_protocol: Protocol | null;
  target_provider_protocol: TargetProviderProtocol | null;
  response_protocol: Protocol | null;
  provider_name: string | null;
  provider_model: string | null;
  passthrough_mutations?: NativePassthroughCarrier["mutations"];
  request_mutations?: NativePassthroughCarrier["mutations"];
}

function approxPromptTokens(req: InternalRequest): number {
  // Cheap heuristic (no tokenizer at the gateway): ~4 chars/token over the
  // concatenated textual content. Good enough for the context-window gate.
  let chars = 0;
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") chars += part.length;
        else if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          chars += (part as { text: string }).text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

// Detect which extra INPUT modalities (image / audio / video / document) the request
// carries IN MESSAGE CONTENT, so the capability filter only routes them to a backend
// that advertises them (P7). Reads the native OpenAI/Responses content-part
// discriminants a client sends (image_url / input_image, input_audio, file) plus the
// IR-normalized part types (image/audio/video/document) in case content was already
// normalized upstream. `image` here is the vision gate for in-message images — the
// legacy `attachments` array is the OTHER vision source (see needsVision below).
export function detectRequestModalities(req: InternalRequest): {
  image: boolean;
  audio: boolean;
  video: boolean;
  document: boolean;
} {
  let image = false;
  let audio = false;
  let video = false;
  let document = false;
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const type = (part as { type?: unknown }).type;
      if (type === "image_url" || type === "input_image" || type === "image") image = true;
      else if (type === "input_audio" || type === "audio") audio = true;
      else if (type === "video") video = true;
      else if (type === "file" || type === "document") {
        // A remote audio/video/image blob with no inline-base64 IR home rides as a
        // `document` (e.g. Gemini fileData audio/* -> IR document, GEM-02). Route it by
        // its real modality via mediaType so the capability filter picks an
        // audio/video/vision-capable backend, not merely a document-capable one.
        const mediaType = (part as { mediaType?: unknown }).mediaType;
        if (typeof mediaType === "string" && mediaType.startsWith("audio/")) audio = true;
        else if (typeof mediaType === "string" && mediaType.startsWith("video/")) video = true;
        else if (typeof mediaType === "string" && mediaType.startsWith("image/")) image = true;
        else document = true;
      }
    }
  }
  return { image, audio, video, document };
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  // Mirror executor/fallback isAbort: rely ONLY on signal.aborted and the raw
  // AbortError name. A message merely containing "aborted" is NOT an abort (an
  // upstream error string can say "aborted upstream"); openai.ts rethrows the
  // raw AbortError on a real client disconnect, so the name check is sufficient.
  if (signal.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

// Per-account user-message queue timeout (issue #93, feature B). Detected by the
// `queueTimeout` flag (not instanceof) so the check survives any package-boundary
// duplication of the QueueTimeoutError class.
function isQueueTimeout(err: unknown): boolean {
  return err instanceof Error && (err as { queueTimeout?: unknown }).queueTimeout === true;
}

// :free candidates may be throttled (429) by the upstream's free tier. That is
// NOT a provider-health signal (principle 5), so it skips to the next candidate
// WITHOUT recording a breaker failure. Reads the real upstream status (not the
// client-facing httpStatus 502) added on UpstreamError.upstreamStatus.
function isFreeAlias(alias: string): boolean {
  return alias.endsWith(":free");
}

// Resolve one candidate alias to its provider client + the metadata native
// passthrough needs (issue #217). This is the SAME resolution the inline block did
// (subscription gate → registry → structural prefix → default), now returning the
// target provider protocol + compat-rewrite flag alongside the client/model so the
// passthrough guard can run without re-resolving. Behavior is byte-identical for the
// provider/providerModel it returns — only the protocol metadata is new.
function resolveAttemptTarget(input: {
  alias: string;
  defaultProvider: ProviderClient;
  providers?: Map<string, ProviderClient>;
  registry: ProviderRegistry;
  knownOAuthPrefixes?: ReadonlySet<string>;
  oauthAliases?: () => ReadonlySet<string>;
  oauthProviderProtocols?: ReadonlyMap<string, ProviderProtocolMetadata>;
}): ResolvedAttemptTarget {
  const {
    alias,
    defaultProvider,
    providers,
    registry,
    knownOAuthPrefixes,
    oauthAliases,
    oauthProviderProtocols,
  } = input;
  const slash = alias.indexOf("/");
  const prefix = slash > 0 ? alias.slice(0, slash) : "";

  if (prefix && (knownOAuthPrefixes?.has(prefix) ?? false)) {
    // SUBSCRIPTION alias (issue #38). The live curation set + the pool are the SINGLE
    // source of truth — re-read per request so a Manage-dialog removal/disconnect takes
    // effect immediately. A subscription alias not CURRENTLY exposed, or whose pool is
    // gone, has no provider here → it fails CLOSED at the caller's !provider check; it
    // NEVER falls through to the registry snapshot or defaultProvider (crossing a
    // subscription/credential boundary). The pool client forwards the bare model.
    const exposed = oauthAliases?.().has(alias) ?? false;
    const pool = providers?.get(prefix);
    const metadata = oauthProviderProtocols?.get(prefix);
    return {
      provider: exposed ? pool : undefined,
      providerName: prefix,
      providerModel: slash > 0 ? alias.slice(slash + 1) : alias,
      targetProviderProtocol: metadata?.targetProviderProtocol ?? "openai_chat",
      providerRequiresCompatibilityRewrite: metadata?.providerRequiresCompatibilityRewrite ?? false,
    };
  }

  // Non-subscription alias. `alias` is the ROUTING key (catalog/pricing/breaker/
  // decision id); `providerModel` is the wire `model`. A resolved alias selects BOTH
  // the upstream model id AND the provider client (so the chain can cross providers).
  const resolved = registry.resolve(alias);
  if (resolved.ok) {
    return {
      provider: providers?.get(resolved.value.providerName),
      providerName: resolved.value.providerName,
      providerModel: resolved.value.providerModel,
      targetProviderProtocol: resolved.value.targetProviderProtocol,
      providerRequiresCompatibilityRewrite: resolved.value.providerRequiresCompatibilityRewrite,
    };
  }

  if (prefix && providers?.has(prefix)) {
    // Structural fallback for a NON-subscription `provider/model` alias the registry
    // never enumerated but whose provider client IS registered by name. Subscription
    // prefixes never reach here (they took the gated branch above).
    const metadata = oauthProviderProtocols?.get(prefix);
    return {
      provider: providers.get(prefix),
      providerName: prefix,
      providerModel: alias.slice(slash + 1),
      targetProviderProtocol: metadata?.targetProviderProtocol ?? "openai_chat",
      providerRequiresCompatibilityRewrite: metadata?.providerRequiresCompatibilityRewrite ?? false,
    };
  }

  // A BARE alias (no provider prefix): Phase-0 passthrough to the default provider
  // with the alias as the upstream model id (single-provider deploys; never
  // substitute a different model silently).
  return {
    provider: defaultProvider,
    providerName: null,
    providerModel: alias,
    targetProviderProtocol: "openai_chat",
    providerRequiresCompatibilityRewrite: false,
  };
}

// Decide whether THIS attempt may forward the verbatim native body (issue #217), and
// build the body-free telemetry trail. The guard (core protocol.ts) is the pure
// decision; here we only assemble its inputs: the runtime flag, whether a verbatim
// native body rode the request, whether the resolved client implements
// nativePassthrough. This is intentionally PER-ATTEMPT: a same-protocol Anthropic
// head can passthrough, while a later OpenAI/Responses fallback translates if reached.
function decideNativePassthroughForAttempt(input: {
  req: InternalRequest;
  target: ResolvedAttemptTarget;
  enabled: boolean;
}): PassthroughTelemetry {
  const { req, target } = input;

  // A native Anthropic body with a system/developer turn INSIDE messages[] may need a
  // model-aware compatibility rewrite. Older/unknown Anthropic models still fold; Opus
  // 4.8 can keep byte-faithful passthrough for its documented valid placement.
  const requiresCompatibilityRewrite =
    target.providerRequiresCompatibilityRewrite ||
    (target.targetProviderProtocol === "anthropic_messages" &&
      anthropicNativeBodyRequiresSystemFold(req.native_request, {
        providerModel: target.providerModel,
      }));

  const decision = canUseNativePassthrough({
    enabled: input.enabled,
    hasNativeRequest: req.native_request !== undefined,
    request: req,
    targetProviderProtocol: target.targetProviderProtocol,
    providerRequiresCompatibilityRewrite: requiresCompatibilityRewrite,
    // Stream-aware feature detection: a stream request needs the streaming sibling
    // (nativePassthroughStream); a non-stream request needs nativePassthrough. A
    // provider that implements only one is `provider_lacks_passthrough` for the other.
    providerSupportsPassthrough: req.stream
      ? typeof target.provider?.nativePassthroughStream === "function"
      : typeof target.provider?.nativePassthrough === "function",
  });

  return {
    passthrough_considered: true,
    passthrough_used: decision.ok,
    passthrough_disable_reason: decision.ok ? null : decision.reason,
    source_protocol: req.protocol,
    target_provider_protocol: target.targetProviderProtocol,
    // Phase 1: passthrough is same-protocol, so the response protocol equals the
    // source (the client gets a native response it understands).
    response_protocol: req.protocol,
    provider_name: target.providerName,
    provider_model: target.providerModel,
    passthrough_mutations: nativePassthroughMutations(req.native_request as never),
  };
}

function stripCacheControlDeep(value: unknown): { value: unknown; stripped: number } {
  if (Array.isArray(value)) {
    let stripped = 0;
    const next = value.map((item) => {
      const child = stripCacheControlDeep(item);
      stripped += child.stripped;
      return child.value;
    });
    return { value: next, stripped };
  }
  if (value === null || typeof value !== "object") return { value, stripped: 0 };
  const out: Record<string, unknown> = {};
  let stripped = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === "cache_control") {
      stripped += 1;
      continue;
    }
    const next = stripCacheControlDeep(child);
    stripped += next.stripped;
    out[key] = next.value;
  }
  return { value: out, stripped };
}

function remoteUrlFromPart(part: Record<string, unknown>): string | null {
  if (typeof part.url === "string") return part.url;
  if (typeof part.file_id === "string") return part.file_id;
  const imageUrl = part.image_url;
  if (typeof imageUrl === "string") return imageUrl;
  if (imageUrl !== null && typeof imageUrl === "object" && !Array.isArray(imageUrl)) {
    const url = (imageUrl as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  const file = part.file;
  if (file !== null && typeof file === "object" && !Array.isArray(file)) {
    const fileId = (file as Record<string, unknown>).file_id;
    if (typeof fileId === "string") return fileId;
  }
  return null;
}

function isRemoteMediaPart(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  const type = typeof part.type === "string" ? part.type : "";
  if (!["image", "image_url", "audio", "video", "document", "file"].includes(type)) {
    return false;
  }
  const url = remoteUrlFromPart(part);
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function countRemoteMediaParts(messages: InternalRequest["messages"]): number {
  let count = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRemoteMediaPart(part)) count += 1;
    }
  }
  return count;
}

function isEmptyAnthropicTextBlock(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  if (part.type !== "text") return false;
  return typeof part.text !== "string" || part.text.trim() === "";
}

function stripEmptyAnthropicTextBlocks(value: unknown): {
  messages: unknown;
  stripped: number;
} {
  if (!Array.isArray(value)) return { messages: value, stripped: 0 };
  let stripped = 0;
  const messages: unknown[] = [];
  for (const message of value) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      messages.push(message);
      continue;
    }
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content)) {
      messages.push(message);
      continue;
    }
    const content = record.content.filter((block) => {
      const isEmptyText = isEmptyAnthropicTextBlock(block);
      if (isEmptyText) stripped += 1;
      return !isEmptyText;
    });
    if (content.length === record.content.length) {
      messages.push(message);
    } else if (content.length > 0) {
      messages.push({ ...record, content });
    }
  }
  return { messages, stripped };
}

function sanitizeAnthropicNativeBody(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  strippedEmptyTextBlocks: number;
} {
  const { messages, stripped } = stripEmptyAnthropicTextBlocks(body.messages);
  return stripped > 0
    ? { body: { ...body, messages }, strippedEmptyTextBlocks: stripped }
    : { body, strippedEmptyTextBlocks: 0 };
}

function prepareNativeRequestForUpstream(
  nativeRequest: InternalRequest["native_request"],
  providerModel: string,
  protocol: Protocol,
  streamReframed: boolean,
  nativeProtocolProfile: ProviderClient["nativeProtocolProfile"] | undefined,
  // Lane-FORCED reasoning effort (issue: lane-forced-reasoning). Set only when the
  // router forced it; rewrites the verbatim body's protocol-specific reasoning field
  // so the override beats the client even on the byte-passthrough path. undefined =>
  // body stays verbatim (default).
  forcedReasoningEffort: string | undefined,
): NativePassthroughCarrier | Record<string, unknown> {
  if (nativeRequest === undefined) {
    throw new Error("native passthrough invoked without a native request");
  }
  const nativeBody = nativePassthroughBody(nativeRequest);
  let body = nativeBody;
  let bodyChanged = false;
  const carrier = isNativePassthroughCarrier(nativeRequest) ? nativeRequest : null;
  const mutations = carrier?.mutations;

  if (nativeBody.model !== providerModel) {
    body = { ...body, model: providerModel };
    bodyChanged = true;
    if (mutations) {
      mutations.model_rewritten = {
        from: typeof nativeBody.model === "string" ? nativeBody.model : null,
        to: providerModel,
      };
    }
  }

  const needsCodexResponsesShim =
    protocol === "openai_responses" && nativeProtocolProfile !== "generic_openai_responses";
  if (needsCodexResponsesShim && body.store !== false) {
    body = { ...body, store: false };
    bodyChanged = true;
    if (mutations) {
      appendMutationList(mutations, "body_shims_applied", ["store_forced_false"]);
      mutations.provider_profile_applied = "codex_official_safe";
    }
  }

  if (protocol === "anthropic_messages") {
    const sanitized = sanitizeAnthropicNativeBody(body);
    if (sanitized.strippedEmptyTextBlocks > 0) {
      body = sanitized.body;
      bodyChanged = true;
      if (mutations) {
        appendMutationList(mutations, "body_shims_applied", [
          "empty_anthropic_text_blocks_stripped",
        ]);
        mutations.empty_anthropic_text_blocks_stripped = sanitized.strippedEmptyTextBlocks;
      }
    }
  }

  // Lane-forced reasoning override (issue: lane-forced-reasoning): rewrite the
  // verbatim body's protocol-specific reasoning field so the forced effort beats the
  // client's value WITHOUT losing native passthrough (the translated path forwards
  // req.reasoning_effort separately). openai_chat never passes through → no-op.
  if (forcedReasoningEffort !== undefined) {
    const rewritten = applyForcedReasoningToNativeBody(body, protocol, forcedReasoningEffort);
    if (rewritten.mutated) {
      body = rewritten.body;
      bodyChanged = true;
      if (mutations)
        appendMutationList(mutations, "body_shims_applied", ["reasoning_effort_forced"]);
    }
  }

  if (streamReframed && mutations) mutations.stream_reframed = true;

  if (carrier === null) return body;
  return bodyChanged
    ? cloneCarrierWithBody(carrier, body)
    : cloneCarrierWithBody(carrier, body, { preserveRawBody: true });
}

function hasResponsesHistoryGap(req: InternalRequest): boolean {
  if (req.protocol !== "openai_responses") return false;
  if (typeof req.provider_raw?.previous_response_id !== "string") return false;
  let hasToolOutput = false;
  let hasLocalToolCall = false;
  for (const message of req.messages) {
    if (message.role === "tool") hasToolOutput = true;
    if (Array.isArray((message as { tool_calls?: unknown }).tool_calls)) hasLocalToolCall = true;
  }
  return hasToolOutput && !hasLocalToolCall;
}

function protocolGuardSkipReason(
  req: InternalRequest,
  targetProviderProtocol: TargetProviderProtocol,
): string | null {
  if (req.protocol !== "openai_responses" || targetProviderProtocol === "openai_responses") {
    return null;
  }
  if (hasResponsesHistoryGap(req)) return "responses_previous_response_id_cross_protocol_blocked";
  if (Array.isArray(req.provider_raw?.responses_native_tools)) {
    return "responses_native_tools_cross_protocol_blocked";
  }
  if (req.provider_raw?.background === true) return "responses_background_cross_protocol_blocked";
  return null;
}

function upstreamStatusOf(err: unknown): number | null {
  return err instanceof UpstreamError ? err.upstreamStatus : null;
}

function errorClassOf(err: unknown): string {
  if (err instanceof UpstreamError) {
    // OAuth (issue #38, D5): a persistent upstream 401 — the client already
    // refreshed + retried once — is an authentication failure, not a generic
    // upstream error. Classify it as `auth_error` (an existing ErrorClass) so the
    // decision record / client error reflects the real cause. This is a pure
    // relabel at the existing classification chokepoint; breaker counting and
    // chain advancement are unchanged (D6 — no new executor branch).
    if (err.upstreamStatus === 401) return "auth_error";
    return err.errorClass;
  }
  return "upstream_error";
}

// Coerce an already-scrubbed upstream error body into the schema's record|null
// shape. A plain object passes through; a primitive/array (e.g. an HTML or text
// error page) is wrapped so the detail is preserved, not silently dropped.
function toRawRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { raw };
}

// Build the redacted per-attempt error_detail (admin-debug-error-detail) from a
// genuine upstream failure. An UpstreamError carries the real upstream status,
// a message, and the key-scrubbed body; any other error degrades to its message
// with no status/body. The telemetry redact gate scrubs this again before it is
// persisted (principle 7), so a key echoed in the body never survives.
function errorDetailOf(err: unknown): AttemptErrorDetail {
  if (err instanceof UpstreamError) {
    return {
      upstream_status: err.upstreamStatus,
      message: err.message,
      provider_raw: toRawRecord(err.providerRaw),
    };
  }
  return {
    upstream_status: null,
    message: err instanceof Error ? err.message : String(err),
    provider_raw: null,
  };
}

// Build the `execute` callback bound to a single request's deps.
export function createExecute(deps: ExecuteAdapterDeps) {
  const {
    defaultProvider,
    providers,
    registry,
    breaker,
    catalog,
    now,
    signal,
    log,
    nativeProtocolPassthroughEnabled,
  } = deps;
  const knownOAuthPrefixes = deps.knownOAuthPrefixes;
  const oauthAliases = deps.oauthAliases;
  const oauthProviderProtocols = deps.oauthProviderProtocols;
  const onOAuthSubscription429 = deps.onOAuthSubscription429;

  // Is `alias` a subscription alias (`<oauthProviderId>/<model>`)? Used to scope the
  // 429 auto-park to OAuth pool accounts (never a configured provider).
  const isOAuthSubscriptionAlias = (alias: string): boolean => {
    const slash = alias.indexOf("/");
    const prefix = slash > 0 ? alias.slice(0, slash) : "";
    return prefix.length > 0 && (knownOAuthPrefixes?.has(prefix) ?? false);
  };

  // Cost of one served attempt = provider usage × catalog pricing (docs/07).
  // Keyed by the candidate ALIAS — the catalog/pricing modelKey is the routing
  // alias (e.g. `deepseek/deepseek-v4-flash`), NOT the bare upstream model id we
  // send on the wire (`deepseek-v4-flash`). See the resolve block below.
  // Prefer an upstream-BILLED cost the response carried (real money charged —
  // `usage.cost_usd` / OpenRouter `usage.cost` / top-level `cost_usd`); otherwise
  // estimate from token usage × catalog pricing (resolveCostUsd, the single
  // override-or-preset rule). Missing BOTH (no billed cost AND no catalog entry /
  // half-filled pricing row) → null ("not measured", distinct from a measured 0)
  // and a logged miss, NEVER a crash (principle 3). Streaming attempts have no
  // usage at peek time → null here, backfilled by the route from the usage chunk.
  const costOf = (alias: string, body: unknown): number | null => {
    const pricing = catalog.get(alias)?.pricing;
    const cost = resolveCostUsd(pricing, body);
    if (cost === null) {
      log?.("info", "cost.pricing_missing", { alias });
    }
    return cost;
  };

  return async function execute(
    plan: ExecutionPlan,
    req: InternalRequest,
  ): Promise<ExecuteOutcome> {
    const attempts: RouteProviderAttempt[] = [];
    // Chain-exhaustion bookkeeping so we can tell apart the two "nobody served"
    // outcomes (docs/07): a HARD capability mismatch (no candidate could ever
    // satisfy the request → capability_unsatisfiable / 422) vs. transient
    // provider failures (all_providers_failed / 502).
    //   • capabilityPruned — at least one candidate was skipped by the capability
    //     filter (known-incompatible).
    //   • attemptedAny — at least one candidate actually reached the upstream
    //     invoke (so a failure here is a provider fault, not a capability gap).
    //     A model with NO catalog entry is usually fail-open: it is attempted, so it
    //     counts here and never yields capability_unsatisfiable (don't over-prune).
    //     Exception: `cached_content` is a hard provider-side context reference; an
    //     unknown-capability target must not run without that required context.
    //   • circuitSkipped — at least one candidate was skipped only because its
    //     breaker was OPEN; that is a transient health signal, not a capability
    //     gap, so it must NOT be reported as capability_unsatisfiable.
    let capabilityPruned = false;
    let attemptedAny = false;
    let circuitSkipped = false;

    // Request-level modality detection (audio/video/document) — computed once and
    // applied to every candidate's capability gate (P7 capability-aware routing).
    const reqModalities = detectRequestModalities(req);
    const needsCachedContent =
      typeof req.cached_content === "string" && req.cached_content.length > 0;

    for (const alias of plan.candidate_chain) {
      const startedAt = now();
      const elapsed = () => Math.max(0, now() - startedAt);

      // Resolve alias -> { provider name, upstream model }. Two DISTINCT ids come
      // out and must not be conflated (fix-upstream-model-id 2026-05-31):
      //   • alias        — the ROUTING key. The catalog/pricing modelKey, the
      //     circuit-breaker key, and the decision-record id are ALL the alias
      //     (e.g. `deepseek/deepseek-v4-flash`). This is what the rest of the system
      //     keys on; the generated catalog is keyed by it.
      //   • providerModel — the provider's REAL upstream model id (e.g.
      //     `deepseek-v4-flash`). The ONLY thing it is used for is the wire `model`
      //     field we send upstream. The upstream rejects anything else with a 4xx/5xx.
      // An unknown alias is a config gap: keep the alias as the upstream model id
      // too and use the default provider (fail-open — never substitute a different
      // model silently). A resolved alias selects BOTH the upstream model id AND
      // the provider client (so the fallback chain can cross providers). If that
      // resolved provider has no client, skip fail-closed; falling back to the
      // default would cross credential/subscription boundaries.
      const target = resolveAttemptTarget({
        alias,
        defaultProvider,
        providers,
        registry,
        knownOAuthPrefixes,
        oauthAliases,
        oauthProviderProtocols,
      });
      const { provider, providerModel } = target;
      if (!provider) {
        attempts.push(skipRow(alias, "provider_unavailable", elapsed()));
        continue;
      }

      // 1) Circuit breaker gate (keyed by alias — the routing unit).
      const gate = breaker.canAttempt(alias);
      if (!gate.allow) {
        circuitSkipped = true;
        attempts.push(skipRow(alias, gate.reason ?? "circuit_open", elapsed()));
        continue;
      }

      // 2) Capability filter. Missing catalog data remains fail-open for generic
      // requests, but not for cached_content: that field is a required Gemini/LiteLLM
      // cached context handle, not an optional affinity hint.
      const caps = catalog.get(alias)?.capabilities;
      if (!caps && needsCachedContent) {
        capabilityPruned = true;
        attempts.push(skipRow(alias, "no_cached_content_support", elapsed()));
        continue;
      }
      if (caps) {
        const verdict = checkCapability(caps, {
          needsTools: Array.isArray(req.tools) && req.tools.length > 0,
          needsJson: isJson(req.response_format),
          needsResponseSchema: isJsonSchema(req.response_format),
          needsVision:
            (Array.isArray(req.attachments) && req.attachments.length > 0) || reqModalities.image,
          needsStreaming: req.stream,
          needsCachedContent,
          estimatedPromptTokens: approxPromptTokens(req),
          maxTokens: req.max_tokens,
          needsAudio: reqModalities.audio,
          needsVideo: reqModalities.video,
          needsDocument: reqModalities.document,
        });
        if (!verdict.ok) {
          capabilityPruned = true;
          attempts.push(skipRow(alias, verdict.skipReason ?? "capability", elapsed()));
          continue;
        }
      }

      const protocolSkip = protocolGuardSkipReason(req, target.targetProviderProtocol);
      if (protocolSkip !== null) {
        capabilityPruned = true;
        attempts.push(skipRow(alias, protocolSkip, elapsed()));
        continue;
      }
      // Past the gates → this candidate is attempted against the upstream. A
      // failure from here on is a PROVIDER fault, not a capability gap.
      attemptedAny = true;

      // Native protocol passthrough decision for THIS attempt (issue #217). Pure
      // guard + body-free telemetry; computed AFTER the capability filter so the
      // passthrough never bypasses a hard capability skip. The decision is a
      // body+response SUBSTITUTION inside the existing per-candidate try/catch — so
      // breaker / abort / free-429 / chain-advance below are identical either way.
      const passthrough = decideNativePassthroughForAttempt({
        req,
        target,
        enabled: nativeProtocolPassthroughEnabled?.() === true,
      });
      let attemptTelemetry: PassthroughTelemetry = passthrough;

      // 3) Invoke the provider (stream or non-stream). We send the RESOLVED
      //    provider model (not the originally-requested alias) — the gateway
      //    picked this model, so the upstream must be told which one to run.
      try {
        // Capture sink for the EXACT bytes forwarded upstream (AFTER memory injection +
        // protocol translation). Each provider fires this just before its HTTP POST with
        // the serialized provider-native body; the value the SERVED attempt captured
        // becomes ExecuteOutcome.upstreamRequest. Scoped per candidate (reset each loop).
        let capturedUpstream: string | null = null;
        const captureUpstream = (wireBody: string): void => {
          capturedUpstream = wireBody;
        };
        if (req.stream && passthrough.passthrough_used) {
          // Native STREAMING passthrough (issue #217, Phase 2): forward the client's
          // VERBATIM native body (which ALREADY carries stream:true) to the upstream and
          // BYTE-RELAY the upstream SSE back — NO translation. peekStream peeks the first
          // chunk for the breaker contract (pre-first-chunk failure → recordFailure +
          // chain advance below; healthy → recordSuccess), only the SOURCE iterable
          // differs (nativePassthroughStream vs chatCompletionStream). The method +
          // native body are guaranteed present (the guard's providerSupportsPassthrough
          // feature-detected nativePassthroughStream, hasNativeRequest proved the body);
          // narrow defensively for type-safety (unreachable after the guard).
          const passthroughStream = provider.nativePassthroughStream;
          const nativeBody = req.native_request;
          if (!passthroughStream || !nativeBody) {
            throw new Error(
              "native streaming passthrough invoked without a native request or client method",
            );
          }
          // Patch ONLY `model` to the RESOLVED upstream id (issue #217): the gateway
          // chose this provider/model, so the upstream must be told which one to run —
          // the client's `model` is the routing alias (e.g. `anthropic/claude-…`), not
          // a real upstream model id. Everything else is forwarded verbatim. Mirrors
          // stripInternal's `model: providerModel`; without it the upstream 404s.
          const passthroughBody = prepareNativeRequestForUpstream(
            nativeBody,
            providerModel,
            req.protocol,
            true,
            provider.nativeProtocolProfile,
            req.reasoning_effort_forced === true ? req.reasoning_effort : undefined,
          );
          if (hasResponsesHistoryGap(req)) {
            const mutations = nativePassthroughMutations(passthroughBody);
            if (mutations) mutations.responses_previous_response_id_native_passthrough = true;
          }
          passthrough.passthrough_mutations = nativePassthroughMutations(passthroughBody);
          const stream = await peekStream(
            () => passthroughStream(passthroughBody, { signal, captureUpstream }),
            signal,
            alias,
            log,
          );
          breaker.recordSuccess(alias);
          // Streamed usage is not known at peek time → cost null, backfilled later.
          attempts.push(okRow(alias, elapsed(), null, passthrough));
          return {
            attempts,
            final: { status: "ok", alias, providerModel },
            body: null,
            stream,
            nativePassthrough: true,
            upstreamRequest: capturedUpstream,
          };
        }
        if (req.stream) {
          // Translate stream path (passthrough disabled): the existing byte-for-byte
          // forward. peekStream opens chatCompletionStream(stripInternal); the row
          // carries the (used:false) passthrough telemetry. No nativePassthrough marker.
          const rendered = stripInternal(req, providerModel, target.targetProviderProtocol);
          attemptTelemetry = withRequestMutations(
            passthrough,
            mergeRequestMutations(
              rendered.request_mutations,
              provider.streamReframed === true ? { stream_reframed: true } : undefined,
            ),
          );
          const stream = await peekStream(
            () => provider.chatCompletionStream(rendered.body, { signal, captureUpstream }),
            signal,
            alias,
            log,
          );
          breaker.recordSuccess(alias);
          // Streamed usage is not known at peek time → cost null (not measured).
          attempts.push(okRow(alias, elapsed(), null, attemptTelemetry));
          return {
            attempts,
            final: { status: "ok", alias, providerModel },
            body: null,
            stream,
            upstreamRequest: capturedUpstream,
          };
        }
        if (passthrough.passthrough_used) {
          // Native passthrough: forward the client's VERBATIM native body to the
          // upstream (NO OpenAI-Chat translation) and return the native response
          // untouched. provider.nativePassthrough is guaranteed present here — the
          // guard's providerSupportsPassthrough feature-detected it. Cost is priced
          // off the native usage, normalized to OpenAI shape (usageFromAnthropicResponse)
          // so resolveCostUsd applies the same token math as a translated attempt.
          const passthroughInvoke = provider.nativePassthrough;
          const nativeBody = req.native_request;
          if (!passthroughInvoke || !nativeBody) {
            // Unreachable: the guard's providerSupportsPassthrough + hasNativeRequest
            // checks already proved both present. Narrow defensively for type-safety.
            throw new Error("native passthrough invoked without a native request or client method");
          }
          // Patch ONLY `model` to the RESOLVED upstream id (issue #217): the client's
          // `model` is the routing alias (e.g. `anthropic/claude-…`), but the gateway
          // picked this upstream model — forward it so the upstream doesn't 404 on the
          // alias. Everything else verbatim. Mirrors stripInternal's `model: providerModel`.
          const passthroughBody = prepareNativeRequestForUpstream(
            nativeBody,
            providerModel,
            req.protocol,
            false,
            provider.nativeProtocolProfile,
            req.reasoning_effort_forced === true ? req.reasoning_effort : undefined,
          );
          if (hasResponsesHistoryGap(req)) {
            const mutations = nativePassthroughMutations(passthroughBody);
            if (mutations) mutations.responses_previous_response_id_native_passthrough = true;
          }
          passthrough.passthrough_mutations = nativePassthroughMutations(passthroughBody);
          const body = await passthroughInvoke(passthroughBody, { signal, captureUpstream });
          breaker.recordSuccess(alias);
          const usage =
            req.protocol === "openai_responses"
              ? usageFromResponsesResponse(body)
              : req.protocol === "gemini"
                ? usageFromGeminiResponse(body)
                : usageFromAnthropicResponse(body);
          const pricedBody = usage ? { ...body, usage } : body;
          attempts.push(okRow(alias, elapsed(), costOf(alias, pricedBody), passthrough));
          return {
            attempts,
            final: { status: "ok", alias, providerModel },
            body,
            stream: null,
            nativePassthrough: true,
            upstreamRequest: capturedUpstream,
          };
        }
        const bodyReq = stripInternal(req, providerModel, target.targetProviderProtocol);
        attemptTelemetry = withRequestMutations(passthrough, bodyReq.request_mutations);
        const body = await provider.chatCompletion(bodyReq.body, { signal, captureUpstream });
        breaker.recordSuccess(alias);
        attempts.push(okRow(alias, elapsed(), costOf(alias, body), attemptTelemetry));
        return {
          attempts,
          final: { status: "ok", alias, providerModel },
          body,
          stream: null,
          upstreamRequest: capturedUpstream,
        };
      } catch (err) {
        // Client abort: non-provider fault. Terminate the chain WITHOUT marking a
        // breaker failure or counting it as all_providers_failed.
        if (isAbort(err, signal)) {
          breaker.recordAbort(alias);
          attempts.push({
            alias,
            skipped: false,
            skip_reason: "aborted",
            status: "error",
            error_class: "client_abort",
            latency_ms: elapsed(),
            cost_usd: null,
            error_detail: null,
            ...defaultPassthroughTelemetry(),
          });
          return {
            attempts,
            final: {
              status: "error",
              error: makeHelmError({
                error_class: "upstream_error",
                message: "client aborted request",
                trace_id: req.request_id,
              }),
            },
            body: null,
            stream: null,
          };
        }
        // Per-account user-message queue timeout (issue #93, feature B):
        // BACKPRESSURE, not provider health — release any probe lock WITHOUT a
        // breaker failure. Terminal (no chain advance): the queue protects THIS
        // subscription's rate limits; spilling onto the next candidate would
        // defeat the throttle the operator deliberately turned on. 503 via
        // lane_unavailable (retryable in the client's eyes).
        if (isQueueTimeout(err)) {
          breaker.recordAbort(alias);
          attempts.push({
            alias,
            skipped: false,
            skip_reason: "user_message_queue_timeout",
            status: "error",
            error_class: "lane_unavailable",
            latency_ms: elapsed(),
            cost_usd: null,
            error_detail: null,
            ...defaultPassthroughTelemetry(),
          });
          return {
            attempts,
            final: {
              status: "error",
              error: makeHelmError({
                error_class: "lane_unavailable",
                message: "user message queue wait timed out; retry shortly",
                trace_id: req.request_id,
              }),
            },
            body: null,
            stream: null,
          };
        }
        // `:free` candidate 429 — ported llm-router semantics (principle 5):
        // skip to the next candidate, do NOT record a breaker failure (free-tier
        // throttling is not a provider-health signal). Distinct log field from
        // execution-fallback: skip_reason 'free_429', error_class 'rate_limited'.
        if (isFreeAlias(alias) && upstreamStatusOf(err) === 429) {
          attempts.push({
            alias,
            skipped: true,
            skip_reason: "free_429",
            status: "error",
            error_class: "rate_limited",
            latency_ms: elapsed(),
            cost_usd: null,
            error_detail: errorDetailOf(err),
            ...defaultPassthroughTelemetry(),
          });
          continue;
        }

        // Genuine pre-first-chunk failure: record on the breaker, try next. This row
        // carries the REAL passthrough telemetry: a failure during nativePassthrough
        // (UpstreamError) lands HERE just like a chatCompletion failure — the trail
        // shows the verbatim-forward was attempted on this candidate before it failed.
        breaker.recordFailure(alias);
        // Auto-park a subscription account that hit its rate/usage limit. A genuine
        // (non-`:free`, handled above) 429 on an OAuth alias means the served account
        // is throttled — signal the gateway to park it so the pool routes around it.
        // Pure side-channel: the breaker failure + chain advance below are unchanged.
        if (upstreamStatusOf(err) === 429 && isOAuthSubscriptionAlias(alias)) {
          onOAuthSubscription429?.(alias);
        }
        attempts.push({
          alias,
          skipped: false,
          skip_reason: null,
          status: "error",
          error_class: errorClassOf(err),
          latency_ms: elapsed(),
          cost_usd: null,
          error_detail: errorDetailOf(err),
          ...attemptTelemetry,
        });
      }
    }

    // Chain exhausted (or empty). Pick the structured terminal error (docs/07):
    //   • empty chain                     → lane_unavailable (503)
    //   • NO candidate was ever attempted AND ≥1 was capability-pruned AND none
    //     was merely circuit-open         → capability_unsatisfiable (422): the
    //     request's hard constraints (json/vision/tools/context) could not be met
    //     by any known-incompatible candidate. A circuit-open skip is transient
    //     (retryable), so its presence keeps us on all_providers_failed.
    //   • otherwise                       → all_providers_failed (502): at least
    //     one candidate was attempted and failed, or skips were transient.
    let errorClass: "lane_unavailable" | "capability_unsatisfiable" | "all_providers_failed";
    let message: string;
    if (plan.candidate_chain.length === 0) {
      errorClass = "lane_unavailable";
      message = "lane has no candidates";
    } else if (!attemptedAny && capabilityPruned && !circuitSkipped) {
      errorClass = "capability_unsatisfiable";
      message = "no candidate satisfies the request's capability constraints";
    } else {
      errorClass = "all_providers_failed";
      message = "all providers in the candidate chain failed";
    }
    return {
      attempts,
      final: {
        status: "error",
        error: makeHelmError({ error_class: errorClass, message, trace_id: req.request_id }),
      },
      body: null,
      stream: null,
    };
  };
}

// Open the provider stream and peek the first chunk so a pre-first-chunk failure
// (connect/handshake/upstream 5xx) rejects HERE (breaker contract), while a
// healthy stream is re-emitted intact — first chunk then the remainder. The
// SOURCE iterable is supplied by `open` (a thunk), so the SAME peek/relay/breaker
// logic serves BOTH the translate path (chatCompletionStream(stripInternal)) and the
// native-streaming-passthrough path (nativePassthroughStream(native_request)). The
// thunk is invoked HERE (inside peekStream) so any synchronous throw from opening the
// iterable is caught by the caller's per-candidate try/catch, exactly as before.
async function peekStream(
  open: () => AsyncIterable<string>,
  _signal: AbortSignal,
  alias: string,
  log?: (level: string, msg: string, fields: Record<string, unknown>) => void,
): Promise<AsyncIterable<string>> {
  const iterable = open();
  const iterator = iterable[Symbol.asyncIterator]();
  const first = await iterator.next(); // may throw (pre-first-chunk failure)

  return (async function* relay(): AsyncGenerator<string> {
    if (!first.done && first.value !== undefined) yield first.value;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value !== undefined) yield next.value;
      }
    } catch (err) {
      // Truncated stream: the attempt was already recorded ok (success fires on
      // the first chunk — breaker semantics unchanged). Emit a structured log so
      // the truncation is observable despite the clean telemetry row. Safe fields
      // only — alias + error_class, NEVER key/payload/raw error (principle 7).
      log?.("warn", "stream.truncated", { alias, error_class: errorClassOf(err) });
      throw err;
    }
  })();
}

// Project the InternalRequest back to an OpenAI-compatible body for the upstream
// passthrough provider. (Protocol re-emit is the docs/05 tasks; here the loose
// normalized shape maps 1:1.)
const FORWARDED_REQUEST_PARAM_KEYS = [
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "n",
  "logprobs",
  "top_logprobs",
  "parallel_tool_calls",
  "modalities",
  "reasoning_effort",
  "user",
  "service_tier",
  "tool_choice",
  "prompt_cache_key",
  "prompt_cache_retention",
  "cached_content",
  "thinking",
  "functions",
  "function_call",
  "prediction",
  "audio",
  "logit_bias",
  "web_search_options",
  "include_server_side_tool_invocations",
  "verbosity",
  "safety_identifier",
] as const satisfies ReadonlyArray<keyof InternalRequest>;

const PROVIDER_RAW_FORWARD_KEYS_BY_PROTOCOL = {
  openai_chat: ["metadata", "store"],
  anthropic_messages: [
    "metadata",
    "store",
    "context_management",
    "mcp_servers",
    "container",
    "speed",
    "output_config",
  ],
  openai_responses: ["metadata", "store", "container"],
  gemini: ["metadata"],
} as const satisfies Record<TargetProviderProtocol, readonly string[]>;

function renderProviderRawForTarget(
  providerRaw: Record<string, unknown> | undefined,
  targetProviderProtocol: TargetProviderProtocol,
): { body: Record<string, unknown>; strippedKeys: string[] } {
  if (providerRaw === undefined) return { body: {}, strippedKeys: [] };
  const out: Record<string, unknown> = {};
  const allowed = new Set<string>(PROVIDER_RAW_FORWARD_KEYS_BY_PROTOCOL[targetProviderProtocol]);
  for (const key of PROVIDER_RAW_FORWARD_KEYS_BY_PROTOCOL[targetProviderProtocol]) {
    const value = providerRaw[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  const strippedKeys = Object.keys(providerRaw).filter((key) => {
    const value = providerRaw[key];
    return value !== undefined && value !== null && !allowed.has(key);
  });
  return { body: out, strippedKeys };
}

function renderOpenAINativeBody(body: Record<string, unknown>): Record<string, unknown> {
  const normalized = openaiTransformer.transformRequestOut({
    model: typeof body.model === "string" ? body.model : "model",
    messages: Array.isArray(body.messages) ? body.messages : [],
    ...body,
  });
  if (normalized && typeof (normalized as Promise<unknown>).then === "function") {
    throw new Error("OpenAI request normalizer unexpectedly returned a Promise");
  }
  const rendered = openaiTransformer.transformRequestIn(normalized as never);
  if (rendered && typeof (rendered as Promise<unknown>).then === "function") {
    throw new Error("OpenAI request renderer unexpectedly returned a Promise");
  }
  const renderedMessages = (rendered as { messages?: unknown }).messages;
  return Array.isArray(renderedMessages) ? { ...body, messages: renderedMessages } : body;
}

function withRequestMutations(
  passthrough: PassthroughTelemetry,
  requestMutations: NativePassthroughCarrier["mutations"] | undefined,
): PassthroughTelemetry {
  if (requestMutations === undefined || Object.keys(requestMutations).length === 0) {
    return passthrough;
  }
  return { ...passthrough, request_mutations: requestMutations };
}

function mergeRequestMutations(
  ...mutations: Array<NativePassthroughCarrier["mutations"] | undefined>
): NativePassthroughCarrier["mutations"] | undefined {
  const out: NativePassthroughCarrier["mutations"] = {};
  for (const mutation of mutations) {
    if (mutation === undefined) continue;
    Object.assign(out, mutation);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stripInternal(
  req: InternalRequest,
  providerModel: string,
  targetProviderProtocol: TargetProviderProtocol,
): { body: Record<string, unknown>; request_mutations?: NativePassthroughCarrier["mutations"] } {
  const requestMutations: NativePassthroughCarrier["mutations"] = {};
  const openAICompatibleWire =
    targetProviderProtocol === "openai_chat" || targetProviderProtocol === "openai_responses";
  const messages = openAICompatibleWire
    ? stripCacheControlDeep(req.messages)
    : { value: req.messages, stripped: 0 };
  const body: Record<string, unknown> = {
    model: providerModel,
    messages: messages.value,
    stream: req.stream,
  };
  if (targetProviderProtocol === "gemini") {
    const remoteMediaCount = countRemoteMediaParts(req.messages);
    if (remoteMediaCount > 0) {
      requestMutations.remote_media_not_materialized = remoteMediaCount;
      appendMutationList(requestMutations, "body_shims_applied", ["remote_media_not_materialized"]);
    }
  }
  if (messages.stripped > 0) {
    requestMutations.cache_control_stripped_for_openai = messages.stripped;
  }
  if (req.tools) {
    const tools = openAICompatibleWire
      ? stripCacheControlDeep(req.tools)
      : { value: req.tools, stripped: 0 };
    body.tools = tools.value;
    if (tools.stripped > 0) {
      requestMutations.cache_control_stripped_for_openai =
        (typeof requestMutations.cache_control_stripped_for_openai === "number"
          ? requestMutations.cache_control_stripped_for_openai
          : 0) + tools.stripped;
    }
  }
  if (req.response_format) body.response_format = req.response_format;
  if (req.max_tokens !== null) body.max_tokens = req.max_tokens;
  for (const key of FORWARDED_REQUEST_PARAM_KEYS) {
    const value = req[key];
    if (value !== undefined && value !== null) body[key] = value;
  }
  if (targetProviderProtocol === "anthropic_messages" && req.cache_control !== undefined) {
    body.cache_control = req.cache_control;
  }
  const renderedRaw = renderProviderRawForTarget(req.provider_raw, targetProviderProtocol);
  if (targetProviderProtocol === "openai_chat" && renderedRaw.strippedKeys.length > 0) {
    requestMutations.provider_raw_stripped_for_openai = renderedRaw.strippedKeys;
  } else if (renderedRaw.strippedKeys.length > 0) {
    requestMutations.provider_raw_stripped_for_target = renderedRaw.strippedKeys;
  }
  for (const [key, value] of Object.entries(renderedRaw.body)) {
    body[key] = value;
  }
  // Streamed usage (cost #6): OpenAI-compatible upstreams only emit a trailing
  // `usage` chunk when asked. Opt in so the gateway can price streamed calls
  // (the route parses that chunk to backfill completion cost). Harmless to the
  // client — it is the standard final usage frame.
  if (req.stream) {
    const streamOptions =
      req.stream_options && typeof req.stream_options === "object" ? req.stream_options : {};
    body.stream_options = { ...streamOptions, include_usage: true };
  }
  const renderedBody =
    targetProviderProtocol === "openai_chat" || targetProviderProtocol === "openai_responses"
      ? renderOpenAINativeBody(body)
      : body;
  return {
    body: renderedBody,
    ...(Object.keys(requestMutations).length > 0 ? { request_mutations: requestMutations } : {}),
  };
}

function isJson(rf: InternalRequest["response_format"]): boolean {
  if (!rf || typeof rf !== "object") return false;
  const t = (rf as { type?: unknown }).type;
  return t === "json_object" || t === "json_schema";
}

// Strict structured output specifically (json_schema, not bare json_object). Gates the
// `no_response_schema_support` capability filter so a json_schema request prunes
// json_object-only backends (official DeepSeek) instead of burning an attempt on a 400.
function isJsonSchema(rf: InternalRequest["response_format"]): boolean {
  if (!rf || typeof rf !== "object") return false;
  return (rf as { type?: unknown }).type === "json_schema";
}

// Inert passthrough telemetry (issue #217): considered:false — for attempt rows that
// never reached the passthrough decision (skip/circuit-open/abort/queue-timeout/
// free-429) so EVERY row carries the same field set.
function defaultPassthroughTelemetry(): PassthroughTelemetry {
  return {
    passthrough_considered: false,
    passthrough_used: false,
    passthrough_disable_reason: null,
    source_protocol: null,
    target_provider_protocol: null,
    response_protocol: null,
    provider_name: null,
    provider_model: null,
  };
}

function skipRow(alias: string, reason: string, latencyMs: number): RouteProviderAttempt {
  return {
    alias,
    skipped: true,
    skip_reason: reason,
    status: "error",
    error_class: null,
    latency_ms: latencyMs,
    cost_usd: null,
    error_detail: null,
    ...defaultPassthroughTelemetry(),
  };
}

function okRow(
  alias: string,
  latencyMs: number,
  costUsd: number | null,
  passthrough: PassthroughTelemetry,
): RouteProviderAttempt {
  return {
    alias,
    skipped: false,
    skip_reason: null,
    status: "ok",
    error_class: null,
    latency_ms: latencyMs,
    cost_usd: costUsd,
    error_detail: null,
    ...passthrough,
  };
}
