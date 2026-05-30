import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// SQLite (Drizzle) table definitions for the sqlite Store adapter. Columns align
// with docs/06 (api_keys) and docs/02 (telemetry / decision record). Dialect
// quirks (no native boolean/array) are encapsulated HERE — core and the supabase
// adapter never see them. Per CLAUDE.md principle 7: NO plaintext column; only
// hash + prefix. Telemetry stores a redacted decision JSON, no plaintext payload.

export const apiKeys = sqliteTable("api_keys", {
  keyId: text("key_id").primaryKey(),
  hash: text("hash").notNull().unique(), // sha256(plaintext); getByHash uses the unique index
  prefix: text("prefix").notNull(), // helm_live_xxxx — display/debug only
  accountId: text("account_id").notNull(),
  role: text("role").notNull(), // 'root' | 'user'
  maxLane: text("max_lane"), // optional cap lane
  allowedLanes: text("allowed_lanes"), // JSON text array (SQLite has no native array)
  allowCustomModel: integer("allow_custom_model", { mode: "boolean" }) // SQLite has no native boolean
    .notNull()
    .default(false),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const telemetry = sqliteTable("telemetry", {
  id: text("id").primaryKey(), // self-generated id
  requestId: text("request_id").notNull().unique(),
  apiKeyId: text("api_key_id").notNull(), // key_id only — never hash/plaintext
  decisionJson: text("decision_json").notNull(), // JSON.stringify(DecisionRecord), redacted
  finalStatus: text("final_status"), // denormalized final.status for querying
  costUsd: integer("cost_usd"), // nullable
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type ApiKeysTable = typeof apiKeys;
export type TelemetryTable = typeof telemetry;
