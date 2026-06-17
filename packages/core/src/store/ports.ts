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
  // Optional human-readable label (cosmetic; never an auth/routing input). Omitted
  // => stored NULL => unnamed.
  name?: string;
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
  // Per-key memory defaults (issue #97). Omitted => the keystore mints the NEW-KEY
  // defaults (mode "inject", project none, thread_source "auto"); pass these
  // explicitly to opt out. Explicit x-memory-* headers always override.
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
  // Hard delete: physically remove the row. Use ONLY after a soft revoke — the
  // "must be disabled first" policy is enforced by the caller (admin route), not
  // here, mirroring how getByHash returns disabled keys and lets the caller
  // decide. Audit history survives: telemetry/payloads reference key_id as an
  // unlinked column (no FK), so past decisions keep their reference. Throws on an
  // unknown id (fail-loud, like disable/updateKey).
  deleteKey(keyId: string): Promise<void>;
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
  // Rename: present (even null) => written; null clears back to unnamed.
  name?: string | null;
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
  // The EXACT provider-native body forwarded upstream — AFTER memory injection and
  // protocol translation (model patched to the resolved upstream id). This is what
  // the model actually received; the diff vs requestJson is the injected memory +
  // translation. Null when capture is off, no provider served, or pre-feature rows.
  // Like requestJson it carries NO plaintext key (the bearer is an HTTP header).
  upstreamRequestJson?: string | null;
  createdAt: Date;
}

export interface RequestPayload {
  requestId: string;
  requestJson: string;
  responseJson: string | null;
  upstreamRequestJson: string | null;
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

// One queryPage row: a recent decision record + the recorded api_key_id (key_id).
// queryRecent's RecentDecisionRecord deliberately omits the key id (no consumer
// needs it); the admin Debug list does — it resolves the key's human NAME for
// display by joining this id to the keystore in the route (core stays headless,
// Principle 1). key_id only — never a hash/plaintext (Principle 7).
export interface TelemetryPageRow extends RecentDecisionRecord {
  apiKeyId: string;
}

// One page of decision rows + the TOTAL matching the same filters (NOT just this
// page) so the UI can render "Page X of Y" without a second round-trip.
export interface TelemetryPage {
  rows: TelemetryPageRow[];
  total: number;
}

// Dashboard token-accounting aggregate over a half-open window [startMs, endMs)
// (admin homepage). ONE method returns all three shapes the dashboard needs in a
// single round-trip: headline `totals`, a time-bucketed `series` for the trend
// chart, and a per-served-model `byModel` breakdown for the doughnut. Computed at
// the SQL layer (SUM / COUNT / GROUP BY over the denormalized token columns — never
// row-by-row in JS) so a wide window stays cheap. Token sums are COALESCE'd to 0
// (an empty window reads 0, not null); cost/latency stay NULLABLE so "not measured"
// stays DISTINCT from a measured 0 (principle 3). Pre-feature / unmeasured rows
// have NULL token columns and contribute 0 (forward-only — no backfill).
export interface TelemetryTotals {
  requests: number;
  okCount: number;
  errorCount: number;
  totalCostUsd: number | null; // null = no priced attempt in the window
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  avgLatencyMs: number | null; // null = empty window
  // True throughput across the window: Σ(completion_tokens) ÷ Σ(generation_ms) ×
  // 1000, over STREAMING rows that measured a generation window (generation_ms > 0)
  // — an aggregate rate, not a mean of per-request rates (which small requests
  // would skew). null = no streamed row in the window had a measured window.
  avgTps: number | null;
}

export interface TelemetrySeriesBucket {
  bucketStartMs: number; // UTC bucket floor (epoch ms): hour or day, by `bucket`
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  requests: number;
}

export interface TelemetryModelUsage {
  servedModel: string | null; // null = pre-feature / unstamped row (UI shows "unknown")
  promptTokens: number;
  completionTokens: number;
  totalTokens: number; // prompt + completion — the doughnut value, ordered desc
  requests: number;
}

export interface TelemetryAggregate {
  totals: TelemetryTotals;
  series: TelemetrySeriesBucket[];
  byModel: TelemetryModelUsage[];
}

export interface TelemetryStore {
  insert(input: InsertTelemetryInput): Promise<{ id: string }>;
  // Optional batch variants (perf): collapse N rows into ONE commit on the
  // synchronous SQLite writer, mirroring MemoryStore.appendMessages. The deferred
  // write queue prefers these; adapters lacking them fall back to per-row insert.
  // An empty array is a no-op.
  insertMany?(inputs: InsertTelemetryInput[]): Promise<void>;
  insertPayloads?(inputs: InsertPayloadInput[]): Promise<void>;
  queryRecent(limit: number): Promise<RecentDecisionRecord[]>; // most recent N, createdAt desc
  // Filtered + paginated recent list for the admin Debug UI. Same createdAt DESC
  // ordering as queryRecent; returns the page plus the full filtered total.
  queryPage(query: TelemetryPageQuery): Promise<TelemetryPage>;
  getByRequestId(requestId: string): Promise<DecisionRecord | null>;
  // Resolve the recorded api_key_id (key_id) for one request. The redacted
  // DecisionRecord deliberately omits it (it carries only key_prefix), so the
  // admin replay path uses this narrow lookup to reconstruct the original key's
  // identity/caps. key_id only — never a hash/plaintext (principle 7). null on a
  // miss (unknown/pruned request).
  getApiKeyId(requestId: string): Promise<string | null>;
  // Resolve the recorded createdAt for one request. The redacted DecisionRecord
  // carries no timestamp field (the time lives in its own column, flattened as
  // created_at by the list endpoint), so the detail header uses this narrow
  // lookup to show the request time. null on a miss (unknown/pruned request).
  getCreatedAt(requestId: string): Promise<Date | null>;
  // POST-MVP Agentic Signals (docs/02). Read every decision record whose
  // createdAt falls in [startMs, endMs) so the background Signal Collector can
  // aggregate a window AFTER the fact. Half-open interval keeps adjacent windows
  // non-overlapping → idempotent re-collect. NEVER called on the request path.
  queryWindow(startMs: number, endMs: number): Promise<DecisionRecord[]>;
  // Dashboard token-accounting aggregate over [startMs, endMs), bucketed by hour or
  // day (admin homepage). SQL-level SUM/COUNT/GROUP BY over the denormalized token
  // columns — see TelemetryAggregate. READ-ONLY; never on the request path. Both
  // adapters implement it; the contract test pins sqlite/pg parity.
  //
  // `tzOffsetMinutes` (east-positive, e.g. UTC+8 = 480) floors the day/hour buckets
  // in the CLIENT's local time, not UTC — so a UTC+8 dashboard's daily series breaks
  // at local midnight instead of 08:00 local. Defaults to 0 (UTC bucketing = legacy
  // behavior); the bucketStartMs it returns is still a UTC epoch ms (= local midnight
  // expressed in UTC), which the admin renders back to local with formatTimestamp.
  aggregate(
    startMs: number,
    endMs: number,
    bucket: "hour" | "day",
    tzOffsetMinutes?: number,
  ): Promise<TelemetryAggregate>;
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
// observation rolled up by (taskType, lane). The collector writes it
// asynchronously off the request path; the optional routing feedback consumer
// reads it fail-open when runtime.signal_feedback.enabled is true. One logical
// row per (taskType, lane); `upsertSignals` overwrites so re-collecting a window
// never double-counts. Pure types — no SQL.
export interface SignalStore {
  // Idempotent upsert keyed by (taskType, lane). Overwrites the prior signal for
  // each pair; a failure here is fail-open (the collector logs, never 5xx).
  upsertSignals(signals: readonly RoutingSignal[]): Promise<void>;
  // Read the latest signal for a (taskType, lane), or null if none yet. Used only
  // by opt-in routing feedback; callers must treat failures as fail-open.
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
  // Persist one raw message; returns the generated message id. Ingest is
  // IDEMPOTENT: a row duplicating an existing (thread_id, message_index, role,
  // content) is a no-op (UNIQUE(thread_id, message_index, role, content_hash) +
  // ON CONFLICT DO NOTHING). The client re-sends the whole transcript each turn,
  // so without this the store grows O(n²); message_index preserves legitimate
  // repeated text at later transcript positions. The returned id is generated per
  // call; ON a conflict it is inert (the existing row keeps its original id —
  // callers must not assume it persisted).
  appendMessage(input: MemoryMessageInput): Promise<string>;
  // Batch variant of appendMessage: persist a whole turn's messages in ONE
  // transaction (a single commit/fsync) instead of N. observe's INBOUND path runs
  // BEFORE the upstream call, so on a long thread the per-message loop adds N
  // synchronous commits of latency to every request (better-sqlite3 blocks the
  // event loop per commit). Returns ONE generated id per input, in input order
  // (length preserved); an id for a row skipped on conflict is inert. Ingest is
  // idempotent like appendMessage — re-sent and intra-batch duplicate messages
  // collapse to one row. An empty batch is a no-op returning []. OPTIONAL on the
  // port: callers fall back to appendMessage in a loop when an adapter (or a
  // pre-existing test fake) does not implement it, so adding it never breaks an
  // existing MemoryStore fixture.
  appendMessages?(inputs: MemoryMessageInput[]): Promise<string[]>;
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
  // Read the current (latest) ACTIVE reflection for a scope, or null if none yet.
  // ARCHIVED reflections (cleared by the decay→rebuild path when a scope's whole
  // active observation set is forgotten — Codex review fix) are invisible here, so
  // neither inject nor the Reflector ever surfaces forgotten content. The Reflector
  // compares the freshly merged text against this to decide whether to bump the
  // version (stable / slowly-changing).
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
  // `limit` BOUNDS the scan (Codex review fix): the sweep's iteration/wallclock caps
  // governed only the archive WRITES, not this READ, so a huge tenant could load +
  // score an unbounded row set up front. The decay job passes
  // max_iterations × chunk_size; the OLDEST active observations come first (most
  // decayed → most likely to archive), and any leftover is swept on the next trigger.
  //
  // `candidates` (Codex review fix II — starvation): with ONLY a limit, the page is
  // the oldest N rows REGARDLESS of score; if those N are all survivors (reinforced/
  // vital), they re-occupy the same page every sweep and condemned rows beyond the
  // limit are NEVER reached. When `candidates` is present the adapter evaluates the
  // SAME forgetting score IN SQL (docs/12: "one pure function, identical in SQL and
  // TypeScript") and returns ONLY below-threshold rows — survivors never occupy the
  // page, archived candidates leave the active set, so every sweep makes progress.
  // The caller still re-verifies with the TS score (defence in depth against float
  // edge disagreement — a row the SQL admits but TS rejects is harmlessly skipped).
  listScorableObservations?(scope: {
    accountId: string;
    limit?: number;
    candidates?: {
      nowMs: number;
      half_life_s: number;
      importance_floor: number;
      importance_ceil: number;
      access_weight: number;
      threshold: number;
    };
  }): Promise<
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
  // docs/12 (Codex review fix) — the reflection-rebuild half of forgetting. A
  // reflection is a derived cache of its scope's ACTIVE observations, so when the
  // decay sweep archives observations the affected reflections go stale and must be
  // rebuilt (or cleared). Two methods support that, both OPTIONAL (`?`, gated):
  //   - listActiveReflectionScopes: the distinct scopes that currently hold an
  //     ACTIVE reflection for the account, so the decay job can enqueue ONE reflector
  //     rebuild per scope (the rebuild re-merges the now-reduced active set, dropping
  //     forgotten content; the open-job dedupe collapses duplicates).
  listActiveReflectionScopes?(accountId: string): Promise<ReflectionScope[]>;
  //   - archiveReflections: soft-invalidate (status='archived') EVERY reflection
  //     version of a scope. Called by the Reflector when a scope's active observation
  //     set is EMPTY (everything decayed) — getReflection then returns null, so the
  //     forgotten reflection stops being injected. Never a DELETE (audit). Account-
  //     scoped via the scope's accountId.
  archiveReflections?(scope: ReflectionScope): Promise<void>;
  //   - getReflectionVersionHighWater: MAX(version) across EVERY status of a scope's
  //     reflection rows (0 when none). Codex review fix: getReflection now hides
  //     archived versions, so deriving next-version from the active row alone would
  //     RESET to 1 after an archive→rebuild cycle — a version regression for clients/
  //     caches reading `reflection_version`. The Reflector writes at high-water + 1
  //     (monotonic forever) while still merging/injecting only the ACTIVE text.
  getReflectionVersionHighWater?(scope: ReflectionScope): Promise<number>;
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
  // Auto-compaction (model→price resolution) — the write half. Stamp the alias
  // of the model that ACTUALLY served the thread's latest turn onto the thread
  // row (memory_threads.last_served_model). Called best-effort by observeOutbound
  // AFTER execution (the served model exists only post-route); the background
  // observer reads it back to price the compaction ledger. FAIL-OPEN: a missed
  // stamp just means the policy's price heuristics take over. Account-guarded.
  // OPTIONAL (`?`): additive — pre-phase fixtures stay valid; callers null-check.
  stampThreadModel?(input: {
    accountId: string;
    threadId: string;
    modelAlias: string;
  }): Promise<void>;
  // Auto-compaction — the read half. Return the thread's stamped model alias
  // (null when never stamped / unknown thread). OPTIONAL (`?`), same contract.
  getThreadMeta?(input: {
    accountId: string;
    threadId: string;
  }): Promise<{ lastServedModel: string | null } | null>;
  // Idle-flush sweep (memory formation backstop) — run on the worker tick, never
  // per request. Return threads that went QUIET with uncompacted history: last
  // activity ≤ idleBeforeMs AND at least one message NEWER than the thread's
  // coverage frontier (the newest message any observation covers — a timestamp
  // approximation of "uncovered"; exact range math stays in the observer).
  // "Last activity" is MAX(memory_messages.created_at), NOT memory_threads.
  // updated_at: ordinary turns append messages but do NOT touch the thread row,
  // so updated_at staleness would mark an active thread idle and compact it
  // mid-conversation. Each candidate carries its project/resource scope (read
  // from the thread row) so the observer can promote the resulting observation to
  // the project/resource reflection — without it, short idle threads would form
  // observations that never reach a readable slot. Once the idle flush compacts
  // everything the frontier catches up and the thread leaves the candidate set,
  // so the sweep TERMINATES (no eternal re-enqueue). `limit` bounds the scan; the
  // open-job dedupe collapses an already-queued thread to a no-op. OPTIONAL (`?`):
  // additive — pre-phase fixtures stay valid; the sweep null-checks.
  listIdleFlushCandidates?(input: {
    idleBeforeMs: number;
    limit: number;
  }): Promise<
    Array<{ accountId: string; threadId: string; projectId?: string; resourceId?: string }>
  >;
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

// Per-account OAuth subscription USAGE aggregate (providers-page Tier 2). Stored as
// one row per (provider_id, account, bucket_ms) where bucket_ms is the UTC-HOUR
// floor — hour granularity so the read can roll up by the ADMIN's LOCAL day (the
// gateway is tz-agnostic at write time). This is an OBSERVABILITY artifact, NOT a
// quota/security boundary, so both methods are FAIL-OPEN at the call site (a
// write/read failure is swallowed + logged, never 5xx's a served request nor breaks
// the admin page — Principle 3). `record` is an additive upsert (requests+1,
// tokens+=, cost null-aware) fired once per served OAuth call. NEVER a plaintext key
// / payload — only aggregate counters (principle 7).
export interface OAuthUsageStore {
  // Fold one served call into its hour bucket: +1 request, +tokens, +costUsd (null
  // stays null until a measured cost arrives — flat-rate plans report no cost).
  // `firstSeenMs` is taken as the MIN across calls (anchors daily-average RPM).
  record(input: {
    providerId: string;
    account: string;
    bucketMs: number; // UTC-hour floor epoch ms (caller floors `now` to the hour)
    tokens: number;
    costUsd: number | null;
    nowMs: number; // epoch ms of this call (firstSeenMs / updatedAt source)
  }): Promise<void>;
  // All accounts' usage ROLLED UP over [startMs, endMs) — the providers page passes
  // the admin's local-day window. Sums the per-hour buckets per (provider, account).
  queryRange(startMs: number, endMs: number): Promise<OAuthUsageRow[]>;
}

// Per-account OAuth subscription QUOTA snapshot (providers-page Tier 3). One row
// per (provider_id, account): the LATEST rate-limit window snapshot, sourced either
// from Anthropic's on-demand usage endpoint (PULL) or Codex response headers (PUSH).
// OBSERVABILITY only — FAIL-OPEN both ways (a stale/missing snapshot renders "—",
// never an error). `upsert` overwrites the single row (latest wins); no history.
export interface OAuthQuotaStore {
  // Persist the latest window snapshot. The param OMITS `usageLimitedUntilMs` by
  // design: the auto-park cooldown is owned solely by setUsageLimit, so a routine
  // observability refresh (new windows) can never clobber an active cooldown — and
  // the type makes that a compile-time guarantee, not a convention.
  upsert(snapshot: Omit<OAuthQuotaSnapshot, "usageLimitedUntilMs">): Promise<void>;
  // The latest snapshot for one account, or null if none captured yet.
  get(providerId: string, account: string): Promise<OAuthQuotaSnapshot | null>;
  // All accounts' latest snapshots (the providers page reads them in one shot).
  getAll(): Promise<OAuthQuotaSnapshot[]>;
  // Remove the snapshot for a (provider_id, account). Used to prune ORPHANS — a
  // renamed / logged-out account otherwise leaves a stale row (e.g. a Codex push
  // under an old label) that would surface as a phantom account on the page.
  delete(providerId: string, account: string): Promise<void>;
  // Set (untilMs) or clear (null) the AUTO-PARK cooldown for one account WITHOUT
  // touching its window snapshot. Upserts a synthetic row when none exists yet — a
  // 429 can park an account before any quota PULL has captured its windows. Passing
  // null is the manual "Reset usage" path.
  setUsageLimit(providerId: string, account: string, untilMs: number | null): Promise<void>;
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
