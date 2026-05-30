-- Agentic Signals (POST-MVP feedback layer; docs/02, research-notes「Plano」).
-- One row per (task_type, lane): the latest rolled-up, REDACTED observation,
-- written ASYNCHRONOUSLY by the background collector — never on the request path.
-- NO key/payload column (principle 7); only aggregate dimensions. Two fallback
-- rates are SEPARATE columns (principle 5): fallback_rate = execution (in-chain
-- swap), classifier_fallback_rate = classification (→ balanced). PRIMARY KEY
-- makes upsert idempotent so re-collecting a window never double-counts.
CREATE TABLE IF NOT EXISTS routing_signals (
  task_type TEXT NOT NULL,
  lane TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  samples INTEGER NOT NULL,
  success_rate REAL NOT NULL,
  fallback_rate REAL NOT NULL,
  classifier_fallback_rate REAL NOT NULL,
  error_rate REAL NOT NULL,
  p50_latency_ms REAL NOT NULL,
  p95_latency_ms REAL NOT NULL,
  avg_cost_usd REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_type, lane)
);
