-- Memory middleware tables (docs/08 "存储模型"). POST-MVP persistence floor:
-- build only — no read/inject/compress. Deliberately ISOLATED from routing/key
-- tables (no FK to lanes/policies/api_keys). memory_messages/observations
-- reference memory_threads ONLY. source_message_range is NOT NULL so compressed
-- observations stay auditable against original messages (docs/08).
--
-- This file is the checked-in, reviewable source of truth for migration v2; the
-- self-contained runner in migrate.ts applies the same DDL (kept in sync).

CREATE TABLE IF NOT EXISTS memory_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  resource_id TEXT,
  owner_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES memory_threads (id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_observations (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES memory_threads (id),
  source_message_range TEXT NOT NULL,
  observation_text TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  referenced_at INTEGER,
  priority INTEGER,
  tags TEXT
);

CREATE TABLE IF NOT EXISTS memory_reflections (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  resource_id TEXT,
  thread_id TEXT,
  reflection_text TEXT NOT NULL,
  version INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_messages_thread ON memory_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_observations_thread ON memory_observations (thread_id, observed_at);
