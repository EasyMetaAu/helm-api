import type { ApiKeyRecord, DecisionRecord } from "@helm/shared";

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
}

// Telemetry insert input: decision record + a redacted key reference. Never
// carries a plaintext key or private payload.
export interface InsertTelemetryInput {
  decision: DecisionRecord;
  apiKeyId: string; // key_id only — not plaintext, not hash
  createdAt: Date;
}

export interface TelemetryStore {
  insert(input: InsertTelemetryInput): Promise<{ id: string }>;
  queryRecent(limit: number): Promise<DecisionRecord[]>; // most recent N, createdAt desc
  getByRequestId(requestId: string): Promise<DecisionRecord | null>;
}

// Optional config persistence (MVP is yaml-first; reserved for admin write-back).
export interface ConfigStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
