import type {
  ApiKeyRecord,
  DecisionRecord,
  MemoryMessageInput,
  MemoryObservationInput,
  MemoryThreadInput,
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

// Store ports (repository pattern). core depends ONLY on these interfaces; the
// sqlite and supabase adapters each implement the same contract. This file is
// pure types — no SQL, no Drizzle import, no web framework. All structured data
// types come from @helm/shared via z.infer. See CLAUDE.md "DB 抽象层".

// Input for creating a key: accepts hash + prefix only — NO plaintext field, so
// the port layer cannot persist a plaintext key (principle 7).
export interface CreateKeyInput {
  keyId: string;
  hash: string; // sha256(plaintext) hex
  prefix: string; // e.g. helm_live_xxxx — display/debug only
  accountId: string;
  role: "root" | "user";
  maxLane?: string;
  allowedLanes?: string[];
  allowCustomModel?: boolean;
  // Per-key rate-limit override (docs/06). Omitted => stored NULL => inherit the
  // system default at check time. 0 => explicitly unlimited for that dimension.
  rateLimitRpm?: number;
  rateLimitTpm?: number;
}

export interface KeyStore {
  createKey(input: CreateKeyInput): Promise<ApiKeyRecord>;
  // Used by the Auth Resolver. A disabled key is still returned (with
  // disabled:true) so the caller — not the store — decides to reject it.
  getByHash(hash: string): Promise<ApiKeyRecord | null>;
  // Used for bootstrap emptiness check / admin display. Never includes plaintext.
  list(): Promise<ApiKeyRecord[]>;
  // Soft revoke: set disabled=true. Never physically deletes, never rewrites
  // other fields in place ("轮转吊销不就地改写").
  disable(keyId: string): Promise<void>;
  // Edit a key's per-key caps (docs/06). PARTIAL: only the fields PRESENT in
  // `patch` are written; an omitted field is left untouched, so two concurrent
  // partial PATCHes on different fields cannot clobber each other (no
  // read-modify-write of the sibling columns). For the nullable fields a value of
  // null CLEARS that column (rate limit → inherit the system default; max_lane /
  // allowed_lanes → no cap); a number/array/boolean sets an explicit value.
  // Touches ONLY the editable cap columns — NEVER role or the immutable identity
  // (key_id/hash/prefix/account_id). Throws if the key id is unknown (fail-loud).
  updateKey(keyId: string, patch: KeyPatch): Promise<void>;
}

// Partial per-key cap edit. A field PRESENT (even as null) is written; an ABSENT
// field is left untouched. Empty patch = no-op (still validates the key exists,
// throwing on an unknown id). Mirrors the editable subset of the key record —
// role and the immutable identity are deliberately absent.
export interface KeyPatch {
  maxLane?: string | null;
  allowedLanes?: string[] | null;
  allowCustomModel?: boolean;
  rateLimitRpm?: number | null;
  rateLimitTpm?: number | null;
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
// DecisionRecord schema; the Debug UI list needs it for the 「时间」 column, so the
// recent-list port surfaces it alongside the record instead of forcing the UI to
// fabricate a timestamp (原则1: UI re-computes nothing).
export interface RecentDecisionRecord {
  record: DecisionRecord;
  createdAt: Date;
}

export interface TelemetryStore {
  insert(input: InsertTelemetryInput): Promise<{ id: string }>;
  queryRecent(limit: number): Promise<RecentDecisionRecord[]>; // most recent N, createdAt desc
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
// (docs/02; research-notes「Plano」). A signal is an aggregated, REDACTED
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

// Memory middleware store (docs/08 "存储模型"). POST-MVP persistence floor: this
// phase only ensures threads + appends raw messages (observe writes originals).
// Read/inject/compress methods are added by the observe/inject tasks. Memory is
// a MIDDLEWARE — these methods never touch routing/lane state. Input types come
// from @helm/shared via z.infer (single source of truth).
export interface MemoryStore {
  // Idempotent upsert of a thread; safe to call on every observed request.
  ensureThread(input: MemoryThreadInput): Promise<void>;
  // Persist one raw message; returns the generated message id.
  appendMessage(input: MemoryMessageInput): Promise<string>;
  // POST-MVP 阶段 2 (Observer). Read a thread's raw messages oldest-first so the
  // background Observer can compress the older ones into an observation. Returns
  // the persisted rows (with ids + createdAt) for an auditable source range.
  listMessages(threadId: string): Promise<RawMessage[]>;
  // Persist one compressed observation; returns its generated id. source range
  // is REQUIRED on the input (docs/08) so memory can be audited against originals.
  appendObservation(input: MemoryObservationInput): Promise<string>;
  // POST-MVP 阶段 2 (Reflector). Read a scope's ACTIVE observations so the
  // background Reflector can merge them into a stable reflection. Scope is
  // project / resource / thread (one or more levels); never cross-project.
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
}

// Optional config persistence (MVP is yaml-first; reserved for admin write-back).
export interface ConfigStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
