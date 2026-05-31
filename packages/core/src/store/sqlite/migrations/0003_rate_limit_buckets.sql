-- Per-key rate-limit token buckets (docs/06 "限流与配额"). POST-MVP per-key
-- limiter. One row per (key_id, dim='rpm'|'tpm'); `tokens` is REAL so fractional
-- token-bucket refill survives across reads. key_id ONLY — never a plaintext or
-- hashed key (principle 7). Counters live in the store (not process memory) so
-- rate-limit windows survive restarts and span multiple gateway instances.
--
-- This file is the checked-in, reviewable source of truth for migration v3; the
-- self-contained runner in migrate.ts applies the same DDL (kept in sync).

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key_id TEXT NOT NULL,
  dim TEXT NOT NULL,
  tokens REAL NOT NULL,
  last_refill_ms INTEGER NOT NULL,
  PRIMARY KEY (key_id, dim)
);
