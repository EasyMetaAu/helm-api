import type {
  ApiKeyRecord,
  DecisionRecord,
  Fact,
  MemoryFactInput,
  MemoryJobEnqueueInput,
  MemoryJobRow,
  MemoryMessageInput,
  MemoryObservationInput,
  MemoryThreadInput,
  OAuthQuotaSnapshot,
  OAuthUsageRow,
  Observation,
  RawMessage,
  Reflection,
  ReflectionScope,
  ReflectionUpsertInput,
  RoutingSignal,
} from "@helm/shared";

import type { BucketState } from "../ratelimit/token-bucket.js";

// Lifecycle status of a background memory job (docs/08 memory_jobs.status).
export type MemoryJobStatus = "pending" | "running" | "done" | "failed";

// Persistence for the per-key rate-limit token buckets. The limiter is a
// security/quota boundary: this port is fail-CLOSED — a read/write failure must
// propagate (the limiter then rejects), NEVER degrade into "unlimited". One row
// per (keyId, dim). `consume` does the atomic read-modify-write (sqlite via a
// transaction; supabase via a single upsert/row-level update) so concurrent
// requests cannot both spend the last token. Keys are key_id only — never a
// plaintext key (principle 7).
export interface RateLimitConsumeResult {
  state: BucketState;
  ok: boolean;
  remaining: number;
  resetSeconds: number;
}

export interface RateLimitStore {
  // Atomically refill + try to consume `cost` tokens from the (keyId, dim)
  // bucket. `state` is the caller's last-known state hint; adapters that persist
  // their own copy (sqlite/supabase) ignore it and read the row inside the txn.
  consume(
    keyId: string,
    dim: "rpm" | "tpm",
    state: BucketState | null,
    capacityPerMin: number,
    cost: number,
    nowMs: number,
  ): Promise<RateLimitConsumeResult>;
}

// Per-key usage-budget dimension (docs/06 "usage budgets"). req = request count,
// tok = total tokens, usd = spend. One token-bucket row per (keyId, dim) in
// `usage_budget_buckets` — same shape as rate_limit_buckets but with a CONFIGURABLE
// rolling window (windowMs) instead of the fixed 60s.
export type BudgetDim = "req" | "tok" | "usd";

export interface BudgetPeekResult {
  remaining: number; // refilled tokens left in the window (NOT persisted by peek)
  ok: boolean; // remaining > 0 — the pre-route sign check
}

// Persistence for the per-key usage-budget buckets. UNLIKE the rate limiter, the
// budget gate is fail-OPEN at settle (a served request is never 5xx'd over a
// settle failure) but fail-CLOSED at peek (a read error propagates so the gate is
// never silently bypassed — same boundary as RateLimitStore). The bucket starts
// FULL (= capacity) so a fresh key has its whole budget; debits deplete it and may
// push it NEGATIVE (a budget is a soft cap settled post-served, not a hard
// reservation — D5-style tolerance). key_id only; never a plaintext key (principle 7).
export interface BudgetStore {
  // Pre-route sign check: refill (in memory) and read remaining for one
  // (keyId, dim). READ-ONLY — never writes (the refilled state is persisted by the
  // next debit). A cold bucket reads as FULL (capacity).
  peek(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    windowMs: number,
    nowMs: number,
  ): Promise<BudgetPeekResult>;
  // Post-served settle: atomically refill + subtract `amount` from the (keyId, dim)
  // bucket and persist. ALWAYS debits (may go negative — soft cap). Returns the new
  // remaining. amount 0 is a no-op debit (advances refill only).
  debit(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    windowMs: number,
    amount: number,
    nowMs: number,
  ): Promise<{ remaining: number }>;
}

// Store ports (repository pattern). core depends ONLY on these interfaces; the
// sqlite and supabase adapters each implement the same contract. This file is
// pure types — no SQL, no Drizzle import, no web framework. All structured data
// types come from @helm/shared via z.infer. See CLAUDE.md "DB abstraction layer".

// Input for creating a key: accepts hash + prefix only — NO plaintext field, so
// the port layer cannot persist a plaintext key (principle 7).
export interface CreateKeyInput {
  keyId: string;
  hash: string; // sha256(plaintext) hex
  prefix: string; // e.g. helm_live_xxxx — display/debug only
  accountId: string;
  role: "root" | "user";
  allowedLanes?: string[];
  allowCustomModel?: boolean;
  // Per-key rate-limit override (docs/06). Omitted => stored NULL => inherit the
  // system default at check time. 0 => explicitly unlimited for that dimension.
  rateLimitRpm?: number;
  rateLimitTpm?: number;
  // Per-key usage budgets (docs/06). Omitted => stored NULL => no cap for that
  // dimension. overBudgetBehavior omitted => stored default ("degrade").
  budgetRequests?: number;
  budgetTokens?: number;
  budgetSpendUsd?: number;
  budgetWindowSeconds?: number;
  overBudgetBehavior?: "degrade" | "reject";
  degradeLane?: string;
  // Max in-flight requests (issue #93). Omitted => stored NULL => unlimited.
  concurrencyLimit?: number;
  // Per-key memory defaults (issue #97). Omitted => off / none / header — memory
  // stays off for this key; explicit x-memory-* headers always override.
  memoryMode?: "off" | "observe" | "inject";
  memoryProjectId?: string;
  memoryThreadSource?: "header" | "auto";
}

export interface KeyStore {
  createKey(input: CreateKeyInput): Promise<ApiKeyRecord>;
  // Used by the Auth Resolver. A disabled key is still returned (with
  // disabled:true) so the caller — not the store — decides to reject it.
  getByHash(hash: string): Promise<ApiKeyRecord | null>;
  // Used for bootstrap emptiness check / admin display. Never includes plaintext.
  list(): Promise<ApiKeyRecord[]>;
  // Soft revoke: set disabled=true. Never physically deletes, never rewrites
  // other fields in place ("rotation/revocation never mutates in place").
  disable(keyId: string): Promise<void>;
  // Edit a key's per-key caps (docs/06). PARTIAL: only the fields PRESENT in
  // `patch` are written; an omitted field is left untouched, so two concurrent
  // partial PATCHes on different fields cannot clobber each other (no
  // read-modify-write of the sibling columns). For the nullable fields a value of
  // null CLEARS that column (rate limit → inherit the system default;
  // allowed_lanes → no whitelist); a number/array/boolean sets an explicit value.
  // Touches ONLY the editable cap columns — NEVER role or the immutable identity
  // (key_id/hash/prefix/account_id). Throws if the key id is unknown (fail-loud).
  updateKey(keyId: string, patch: KeyPatch): Promise<void>;
}

// Partial per-key cap edit. A field PRESENT (even as null) is written; an ABSENT
// field is left untouched. Empty patch = no-op (still validates the key exists,
// throwing on an unknown id). Mirrors the editable subset of the key record —
// role and the immutable identity are deliberately absent.
export interface KeyPatch {
  allowedLanes?: string[] | null;
  allowCustomModel?: boolean;
  rateLimitRpm?: number | null;
  rateLimitTpm?: number | null;
  // Budget edits: present (even null) => written; null clears the cap (no cap).
  // overBudgetBehavior has no null (always resolves to degrade|reject).
  budgetRequests?: number | null;
  budgetTokens?: number | null;
  budgetSpendUsd?: number | null;
  budgetWindowSeconds?: number | null;
  overBudgetBehavior?: "degrade" | "reject";
  degradeLane?: string | null;
  // Concurrency edit: present (even null) => written; null clears to unlimited.
  concurrencyLimit?: number | null;
  // Memory default edits (issue #97). mode/source always resolve to an enum
  // value (no null); project null clears it back to none.
  memoryMode?: "off" | "observe" | "inject";
  memoryProjectId?: string | null;
  memoryThreadSource?: "header" | "auto";
}

// Telemetry insert input: decision record + a redacted key reference. Never
// carries a plaintext key or private payload.
export interface InsertTelemetryInput {
  decision: DecisionRecord;
  apiKeyId: string; // key_id only — not plaintext, not hash
  createdAt: Date;
}

// Full request/response body capture (admin "System Settings" → capture_payloads).
// Stored in a SEPARATE table from the decision record so it prunes independently
// (payload_retention_days) and never bloats the decision JSON. Unlike telemetry,
// this is NOT redacted — it is the verbatim client request body + the assembled
// provider response. It carries NO plaintext API key: the bearer lives in the
// request's Authorization HEADER, which is never part of the chat body stored here.
export interface InsertPayloadInput {
  requestId: string;
  requestJson: string; // verbatim client request body, serialized
  responseJson: string | null; // assembled full response (null on error / unknown)
  createdAt: Date;
}

export interface RequestPayload {
  requestId: string;
  requestJson: string;
  responseJson: string | null;
  createdAt: Date;
}

// A recent decision row paired with the time the gateway recorded it. `createdAt`
// is STORE metadata (a separate column), deliberately kept OUT of the redacted
// DecisionRecord schema; the Debug UI list needs it for the "Time" column, so the
// recent-list port surfaces it alongside the record instead of forcing the UI to
// fabricate a timestamp (Principle 1: UI re-computes nothing).
export interface RecentDecisionRecord {
  record: DecisionRecord;
  createdAt: Date;
}

// Filter + page request for the admin Debug list (docs/07). `limit`/`offset` drive
// numbered pagination (createdAt DESC); the rest are optional filters. `startMs`/
// `endMs` bound createdAt as a half-open window [startMs, endMs) — same convention
// as queryWindow. `status` matches the denormalized final_status column; `decidedBy`
// / `lane` / `model` are extracted from the decision JSON by the adapter (`model`
// matches the requested OR served model, substring, case-insensitive).
export interface TelemetryPageQuery {
  limit: number;
  offset: number;
  startMs?: number;
  endMs?: number;
  status?: DecisionRecord["final"]["status"];
  decidedBy?: DecisionRecord["classifier"]["decided_by"];
  lane?: string;
  model?: string;
}

// One page of decision rows + the TOTAL matching the same filters (NOT just this
// page) so the UI can render "Page X of Y" without a second round-trip.
export interface TelemetryPage {
  rows: RecentDecisionRecord[];
  total: number;
}

export interface TelemetryStore {
  insert(input: InsertTelemetryInput): Promise<{ id: string }>;
  queryRecent(limit: number): Promise<RecentDecisionRecord[]>; // most recent N, createdAt desc
  // Filtered + paginated recent list for the admin Debug UI. Same createdAt DESC
  // ordering as queryRecent; returns the page plus the full filtered total.
  queryPage(query: TelemetryPageQuery): Promise<TelemetryPage>;
  getByRequestId(requestId: string): Promise<DecisionRecord | null>;
  // POST-MVP Agentic Signals (docs/02). Read every decision record whose
  // createdAt falls in [startMs, endMs) so the background Signal Collector can
  // aggregate a window AFTER the fact. Half-open interval keeps adjacent windows
  // non-overlapping → idempotent re-collect. NEVER called on the request path.
  queryWindow(startMs: number, endMs: number): Promise<DecisionRecord[]>;
  // Full-payload capture (opt-out via runtime settings capture_payloads). Upsert
  // by request_id (idempotent: the stream path may write the request first, then
  // backfill the assembled response). Stores verbatim bodies — never redacted.
  insertPayload(input: InsertPayloadInput): Promise<void>;
  getPayload(requestId: string): Promise<RequestPayload | null>;
  // Delete payloads with createdAt strictly older than the cutoff (epoch ms).
  // Drives payload_retention_days auto-prune; safe to call opportunistically.
  prunePayloads(olderThanMs: number): Promise<void>;
}

// SignalStore — persistence for the POST-MVP Agentic Signals feedback layer
// (docs/02; research-notes "Plano"). A signal is an aggregated, REDACTED
// observation rolled up by (taskType, lane). This is an OBSERVABILITY artifact:
// the collector writes it asynchronously off the request path, and (this task)
// nothing reads it back into routing — `getSignal` exists for a FUTURE
// consumption task. One logical row per (taskType, lane); `upsertSignals`
// overwrites so re-collecting a window never double-counts. Pure types — no SQL.
export interface SignalStore {
  // Idempotent upsert keyed by (taskType, lane). Overwrites the prior signal for
  // each pair; a failure here is fail-open (the collector logs, never 5xx).
  upsertSignals(signals: readonly RoutingSignal[]): Promise<void>;
  // Read the latest signal for a (taskType, lane), or null if none yet. Reserved
  // for the future routing-feedback consumer; unused by the MVP route.
  getSignal(taskType: string, lane: string): Promise<RoutingSignal | null>;
}

// Memory middleware store (docs/08 "storage model"). POST-MVP persistence floor: this
// phase only ensures threads + appends raw messages (observe writes originals).
// Read/inject/compress methods are added by the observe/inject tasks. Memory is
// a MIDDLEWARE — these methods never touch routing/lane state. Input types come
// from @helm/shared via z.infer (single source of truth).
export interface MemoryStore {
  // Idempotent upsert of a thread; safe to call on every observed request.
  ensureThread(input: MemoryThreadInput): Promise<void>;
  // Persist one raw message; returns the generated message id.
  appendMessage(input: MemoryMessageInput): Promise<string>;
  // POST-MVP Phase 2 (Observer). Read a thread's raw messages oldest-first so the
  // background Observer can compress the older ones into an observation. Returns
  // the persisted rows (with ids + createdAt) for an auditable source range.
  listMessages(scope: { threadId: string; accountId: string }): Promise<RawMessage[]>;
  // Persist one compressed observation; returns its generated id. source range
  // is REQUIRED on the input (docs/08) so memory can be audited against originals.
  appendObservation(input: MemoryObservationInput): Promise<string>;
  // POST-MVP Phase 2 (Reflector). Read a scope's ACTIVE observations so the
  // background Reflector can merge them into a stable reflection. Two read
  // shapes: a THREAD scope returns that thread's rows (inject/observer); a
  // project/resource scope AGGREGATES across all the owner's threads carrying
  // that id (the Reflector's target read — a project reflection covers the whole
  // project). Never cross-project, never cross-account.
  listObservations(scope: ReflectionScope): Promise<Observation[]>;
  // Read the current (latest) reflection for a scope, or null if none yet. The
  // Reflector compares the freshly merged text against this to decide whether
  // to bump the version (stable / slowly-changing).
  getReflection(scope: ReflectionScope): Promise<Reflection | null>;
  // Persist a NEW reflection version (version+1) when the merged text actually
  // changed. Returns its generated id. Never called when the text is unchanged
  // (keeps the injected prefix cache-friendly).
  upsertReflection(input: ReflectionUpsertInput): Promise<string>;
  // Update a background job's lifecycle status (+ optional error on failure).
  // The Observer/Reflector mark their job done/failed; failure is recorded here,
  // never bubbled to the main request path (fail-open).
  updateJobStatus(jobId: string, status: MemoryJobStatus, error?: string): Promise<void>;
  // POST-MVP Phase 2 (queue). Enqueue a background job (observer | reflector) for
  // a scope. The scope is encoded into the single scope_id column (canonical JSON,
  // D1). DEDUPE (D6): if an OPEN (pending) job of the same (type, scope_id) already
  // exists, return its id instead of inserting a second row — this caps an observer
  // flood to one pending row per scope. Best-effort caller: inject treats an
  // enqueue throw as a "failed" writeback (fail-open), never a 5xx.
  enqueueJob(input: MemoryJobEnqueueInput): Promise<string>;
  // POST-MVP Phase 2 (queue). Atomically claim up to `limit` open jobs, flipping
  // them to running in ONE statement so two workers (or two ticks) never
  // double-process a row, and return them with scope_id DECODED back to a
  // ReflectionScope. Claimable = pending, PLUS running rows whose lease
  // (updated_at) expired — crash recovery: a worker that died mid-job must not
  // leave its scope blocked forever behind the running-row dedupe. Empty queue →
  // []. The worker runs each claimed job (itself fail-open) then marks it
  // done/failed via updateJobStatus.
  claimPendingJobs(limit: number): Promise<MemoryJobRow[]>;
  // docs/12 "Access reinforcement" (P3) — the loop-closer. After the injector
  // assembles the prefix and knows EXACTLY which observations/reflections
  // survived the budget trim, it fires ONE batched, account-guarded write:
  //   UPDATE … SET reference_count = reference_count + 1, referenced_at = :now …
  // bumping the rows it injected. That resets their recency to ~1.0 so a used
  // memory survives the next sweep/score-trim; memories that stop being injected
  // stop being reinforced and quietly decay (the whole forgetting loop, closed by
  // touching two columns). The accountId guard makes it tenant-safe even though
  // the injected ids already came from an account-scoped read (defence in depth,
  // matching the read predicates): observations are guarded via their thread's
  // owner_id, reflections via owner_id directly. FAIL-OPEN: this is NEVER awaited
  // on the response path (inject fires it fire-and-forget); a failure leaves the
  // counters stale (the score just uses the old value) and never affects the
  // request. Empty id lists are a no-op. Only CALLED when forgetting.enabled is on.
  //
  // OPTIONAL on the port (`?`): the real sqlite + postgres adapters BOTH implement
  // it, but it is gated behind forgetting.enabled and is purely additive (docs/12
  // P3 — inert until the flag is on). Marking it optional keeps every existing
  // MemoryStore fixture/fake that predates this phase valid WITHOUT being rewritten
  // — the gating lever (`forgetting.enabled: false` ⇒ byte-identical behaviour)
  // applies to the type surface too. Callers must null-check before invoking.
  bumpReferences?(input: {
    accountId: string;
    observationIds: string[];
    reflectionIds: string[];
    now: Date;
  }): Promise<void>;
  // docs/12 "Eviction, demotion, promotion" (P5 decay sweep, pass 1) — the read half.
  // Return EVERY ACTIVE observation owned by the account, with ONLY the forgetting-
  // score input fields (referenced_at / observed_at / reference_count / importance).
  // Account-scoped via the observation's thread owner_id (observations carry no
  // owner_id column — they inherit it from memory_threads, matching the existing read
  // predicates); archived rows are excluded so the sweep is idempotent (a re-run sees
  // nothing already demoted). The mid-tier `fallback_ts` is observed_at, surfaced here
  // so the pure score fn can coalesce a null referenced_at without the store knowing
  // the tier rules. OPTIONAL on the port (`?`) for the same reason as bumpReferences:
  // additive + gated, so pre-phase fixtures stay valid; callers null-check.
  listScorableObservations?(scope: { accountId: string }): Promise<
    Array<{
      id: string;
      referencedAt: Date | null;
      observedAt: Date;
      referenceCount: number;
      importance: number;
    }>
  >;
  // docs/12 "Demote mid → archived (soft-invalidate)" — the write half of the sweep.
  // Soft-invalidate the named observations: status='archived', archived_at=now. NEVER
  // a DELETE (audit-friendly — archived rows stop being injected + stop counting toward
  // the budget, but survive for audit/retention). ACCOUNT-GUARDED via the thread's
  // owner_id (defence in depth; the ids already came from an account-scoped read).
  // Empty id lists are a no-op. OPTIONAL (`?`): additive + gated, same contract as
  // listScorableObservations / bumpReferences.
  archiveObservations?(input: { accountId: string; ids: string[]; now: Date }): Promise<void>;
  // docs/12 P5 trigger — the buffer-flush gate, run OFF the request path (the worker
  // tick, never per request). Return the account ids DUE for a decay sweep: an account
  // owning ≥1 active observation that EITHER has accumulated ≥ `triggerObservations`
  // active observations since its last decay sweep, OR whose last sweep was ≥
  // `triggerIntervalS` ago (an account that has NEVER been swept is due on the time
  // gate). "Last sweep" = the newest memory_jobs row of type='decay' for that account's
  // scope. Pure read; the caller enqueues one decay job per returned account and the
  // open-job dedupe index collapses duplicates (uniq_memory_jobs_open_type_scope), so a
  // returned-but-already-queued account is a harmless no-op. OPTIONAL (`?`): additive +
  // gated — only the forgetting-enabled worker calls it. Account-scoped throughout.
  listDecayCandidateAccounts?(input: {
    triggerObservations: number;
    triggerIntervalS: number;
    nowMs: number;
  }): Promise<string[]>;
  // docs/12 "Eviction, demotion, promotion" passes 2–3 (P6) — fact ingest with
  // DETERMINISTIC dedup + same-subject supersede, all in ONE batch. The Reflector
  // extracts discrete facts (its new sibling output) and calls this; per fact:
  //   - dedup (Mem0 borrow): if (owner_id, content_hash) already exists → SKIP
  //     (idempotent — the account-scoped UNIQUE index is the boundary, so the same
  //     assertion ingested twice is one row);
  //   - else INSERT, then SUPERSEDE (Graphiti borrow, pure datetime UPDATE — no
  //     LLM): if a still-ACTIVE fact with the same (owner_id, subject_key),
  //     narrowed by the scope columns that are non-null on the NEW fact, and an
  //     OLDER valid_from exists → stamp the old row expired_at=now,
  //     invalid_at=new.valid_from. NEVER a DELETE (audit-friendly; decay hides,
  //     retention deletes). enable_llm_supersede contradiction-finding beyond
  //     same-subject_key is OUT of scope here (off by default).
  // owner_id is the TENANT BOUNDARY (a fact may have a null thread_id, so it
  // cannot lean on memory_threads — docs/12 "Tenant isolation"): every predicate
  // includes it, and the top-level `accountId` is the authoritative guard that
  // each fact's ownerId must match. The whole batch is ONE transaction where the
  // adapter allows (sqlite synchronous txn; pg statement-by-statement). OPTIONAL
  // (`?`): additive + gated behind forgetting.enabled — pre-phase fixtures stay
  // valid; the Reflector null-checks before calling.
  insertFactsReconciled?(input: {
    accountId: string;
    scope: { projectId?: string; resourceId?: string; threadId?: string };
    facts: MemoryFactInput[];
    now: Date;
  }): Promise<void>;
  // docs/12 "Supersede within long" — the fact READ half. Return the account's
  // facts that are still alive: owner_id = accountId AND status='active' AND
  // expired_at IS NULL (the single predicate that makes superseded/archived facts
  // invisible without deleting them), optionally narrowed by the in-account scope
  // columns. Account-scoped throughout (owner_id is the tenant boundary). OPTIONAL
  // (`?`): additive + gated, same contract as the sweep reads.
  listActiveFacts?(input: {
    accountId: string;
    projectId?: string;
    resourceId?: string;
    threadId?: string;
  }): Promise<Fact[]>;
  // docs/12 "Hard-delete (rare, retention only)" pass 4 (P7) — the ONLY DELETE in the
  // forgetting system. Mirrors the existing payload_retention_days prune (an account-
  // AGNOSTIC, age-cutoff sweep run off the request path on the worker tick). TWO deletes
  // in one call, each over the WHOLE store (a retention age cutoff is tenant-neutral by
  // construction — archived_at / expired_at is the same wallclock for every account):
  //   1. DELETE memory_observations WHERE status='archived'
  //        AND archived_at < archivedObservationsBeforeMs
  //   2. DELETE memory_facts        WHERE expired_at IS NOT NULL
  //        AND expired_at < expiredFactsBeforeMs
  // NEVER touches active observations, unexpired facts, or reflections (reflections are
  // never hard-deleted by retention — docs/12 "Facts and reflections are never hard-
  // deleted by score — only by explicit retention age, and only after being archived/
  // expired first"). The cutoffs are STRICT lower bounds (strictly-older-than), matching
  // prunePayloads, so a row stamped exactly at the cutoff survives. Returns the deleted
  // row counts purely for the caller's log line. OPTIONAL (`?`): additive + gated behind
  // forgetting.enabled — pre-phase fixtures stay valid; the pruner null-checks before use.
  pruneExpiredMemory?(input: {
    archivedObservationsBeforeMs: number;
    expiredFactsBeforeMs: number;
  }): Promise<{ observationsDeleted: number; factsDeleted: number }>;
}

// Optional config persistence (MVP is yaml-first; reserved for admin write-back).
export interface ConfigStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

// Persisted OAuth subscription credentials (issue #38 follow-up — makes the
// token manager's in-memory cache survive restarts and handle REFRESH-TOKEN
// ROTATION). One row per (provider_id, account). UNLIKE api_keys (hash only),
// these secrets are stored REVERSIBLY because they are replayed to the upstream
// token endpoint — so `accessEnc`/`refreshEnc` are AES-256-GCM ciphertext
// (store/crypto/token-cipher.ts), NEVER plaintext. The adapter only ever stores
// and returns the ciphertext blobs verbatim; encryption/decryption stays in the
// CALLER (token manager / CLI), exactly as the KeyStore never hashes (principle 7).
export interface OAuthTokenRecord {
  providerId: string; // 'anthropic' | 'github-copilot' | ... (OAuth provider id)
  account: string; // logical account label; 'default' for the single-account UX
  accessEnc: string | null; // AES-GCM blob; null when the provider derives access lazily
  refreshEnc: string | null; // AES-GCM blob (the long-lived credential)
  expiresAt: number | null; // ms epoch the access token expires; null = unknown
  meta: string | null; // provider-specific JSON (e.g. copilot proxy base / enterprise host)
  updatedAt: number; // ms epoch of the last write (rotation timestamp)
}

// Per-account OAuth subscription USAGE aggregate (providers-page Tier 2). One row
// per (provider_id, account, day) — `day` is the UTC-midnight epoch ms. This is an
// OBSERVABILITY artifact, NOT a quota/security boundary, so both methods are
// FAIL-OPEN at the call site (a write/read failure is swallowed + logged, never
// 5xx's a served request nor breaks the admin page — Principle 3). `record` is an
// additive upsert (requests+1, tokens+=, cost null-aware) fired once per served
// OAuth call. NEVER a plaintext key / payload — only aggregate counters (principle 7).
export interface OAuthUsageStore {
  // Fold one served call into today's row: +1 request, +tokens, +costUsd (null
  // stays null until a measured cost arrives — flat-rate plans report no cost).
  // `firstSeenMs` is taken as the MIN across calls (anchors daily-average RPM).
  record(input: {
    providerId: string;
    account: string;
    dayMs: number; // UTC-midnight epoch ms (caller floors `now`)
    tokens: number;
    costUsd: number | null;
    nowMs: number; // epoch ms of this call (firstSeenMs / updatedAt source)
  }): Promise<void>;
  // All accounts' aggregate rows for one UTC day (the providers page reads today).
  queryDay(dayMs: number): Promise<OAuthUsageRow[]>;
}

// Per-account OAuth subscription QUOTA snapshot (providers-page Tier 3). One row
// per (provider_id, account): the LATEST rate-limit window snapshot, sourced either
// from Anthropic's on-demand usage endpoint (PULL) or Codex response headers (PUSH).
// OBSERVABILITY only — FAIL-OPEN both ways (a stale/missing snapshot renders "—",
// never an error). `upsert` overwrites the single row (latest wins); no history.
export interface OAuthQuotaStore {
  upsert(snapshot: OAuthQuotaSnapshot): Promise<void>;
  // The latest snapshot for one account, or null if none captured yet.
  get(providerId: string, account: string): Promise<OAuthQuotaSnapshot | null>;
  // All accounts' latest snapshots (the providers page reads them in one shot).
  getAll(): Promise<OAuthQuotaSnapshot[]>;
  // Remove the snapshot for a (provider_id, account). Used to prune ORPHANS — a
  // renamed / logged-out account otherwise leaves a stale row (e.g. a Codex push
  // under an old label) that would surface as a phantom account on the page.
  delete(providerId: string, account: string): Promise<void>;
}

export interface OAuthTokenStore {
  // Load the stored credential for a provider/account, or null if none.
  get(providerId: string, account: string): Promise<OAuthTokenRecord | null>;
  // Upsert (login + every rotation write-back). Overwrites the row for the
  // (provider_id, account) pair — credential rotation never mutates a sibling.
  upsert(rec: OAuthTokenRecord): Promise<void>;
  // Remove a stored credential (CLI `logout`).
  delete(providerId: string, account: string): Promise<void>;
  // Inventory for the CLI `list` — NEVER returns secret columns.
  list(): Promise<
    Array<Pick<OAuthTokenRecord, "providerId" | "account" | "expiresAt" | "updatedAt">>
  >;
}
