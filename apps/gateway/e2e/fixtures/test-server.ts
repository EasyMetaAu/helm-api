// e2e launcher: boots a real gateway with a deterministic, pre-seeded API key so
// tests don't have to scrape the bootstrap log. Provider base_url points at the
// local mock upstream. Offline + deterministic.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { hashKey } from "@helm/core";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { SEED_TRACE_ID } from "./admin.js";

const TEST_KEY = process.env.HELM_TEST_KEY ?? "helm_live_e2e_testkey";
const DATA_DIR = process.env.HELM_DATA_DIR ?? "./.e2e-data";
const DB_PATH = `${DATA_DIR}/helm.db`;

// Fresh data dir each run so the seeded key is the only one (and bootstrap is a
// no-op because a key already exists).
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

const { createRuntimeMemoryCoordinator, createSqliteDb, SqliteKeyStore, SqliteTelemetryStore } =
  await import("@helm/core");
const seedDb = createSqliteDb(DB_PATH);
const keyStore = new SqliteKeyStore(seedDb);
await keyStore.createKey({
  keyId: "k_e2e",
  hash: hashKey(TEST_KEY),
  prefix: "helm_live_e2e",
  accountId: "acct_e2e",
  role: "root",
});

// Two per-key usage-budget keys (docs/06, e2e.budget). Each caps requests at 1 over
// the window: the FIRST request is served at its full lane (cold bucket = full),
// the SECOND is over budget. The `degrade` key then drops to the economy lane (keep
// serving); the `reject` key returns a 429. Request-count needs no upstream usage,
// so this is fully deterministic against the mock.
await keyStore.createKey({
  keyId: "k_budget_degrade",
  hash: hashKey("helm_live_e2e_budget_degrade"),
  prefix: "helm_live_bd",
  accountId: "acct_e2e",
  role: "user",
  budgetRequests: 1,
  overBudgetBehavior: "degrade",
  degradeLane: "economy",
});
await keyStore.createKey({
  keyId: "k_budget_reject",
  hash: hashKey("helm_live_e2e_budget_reject"),
  prefix: "helm_live_br",
  accountId: "acct_e2e",
  role: "user",
  budgetRequests: 1,
  overBudgetBehavior: "reject",
});

// Explicit-passthrough keys (docs/04 lane-as-model + strict model validation).
// `k_custom` may name any known model OR lane; `k_custom_capped` additionally
// confines explicit lanes to allowed_lanes=[economy] — naming another lane is a
// 400 invalid_request (loud reject, never a silent downgrade).
await keyStore.createKey({
  keyId: "k_custom",
  hash: hashKey("helm_live_e2e_custom"),
  prefix: "helm_live_cu",
  accountId: "acct_e2e",
  role: "user",
  allowCustomModel: true,
});
await keyStore.createKey({
  keyId: "k_custom_capped",
  hash: hashKey("helm_live_e2e_custom_capped"),
  prefix: "helm_live_cc",
  accountId: "acct_e2e",
  role: "user",
  allowCustomModel: true,
  allowedLanes: ["economy"],
});

// Seed one full decision record for the admin requests views (e2e.admin). It is
// a pre-built, redacted DecisionRecord — NOT a live upstream call — so the admin
// request list/detail have a deterministic row with a trace_id, a classified
// lane, a candidate chain, a provider attempt, and a cost. The record carries no
// plaintext key/payload (Principle 7); the views surface key by prefix only.
const telemetry = new SqliteTelemetryStore(seedDb);
await telemetry.insert({
  apiKeyId: "k_e2e",
  // NOW, not a fixed date and not now−1h: the requests list defaults to TODAY
  // (since local midnight). `now` is within "today" in every timezone, whereas a
  // past offset (the old now−1h) falls into YESTERDAY when the suite runs within
  // that offset after local midnight — a deterministic midnight-boundary failure.
  // A hard-coded date silently ages out entirely (time bomb — the 2026-05-31 seed).
  createdAt: new Date(),
  decision: {
    request_id: SEED_TRACE_ID,
    trace_id: SEED_TRACE_ID,
    request_body_bytes: 1_572_864,
    requested_model: "gpt-4o-mini",
    classifier: {
      task_type: "coding",
      complexity: "high",
      confidence: 0.92,
      decided_by: "rules",
      eval_cache_hit: null,
      constraints: { require_tools: false, require_json: false },
      explanation: ["matched: code_fence", "matched: keyword:refactor"],
    },
    policy: { matched_policy_id: null, reason: "no policy matched" },
    lane: { selected_lane: "premium", candidate_chain: ["premium", "balanced"] },
    provider_attempts: [
      {
        alias: "best_reasoning_model",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 1234,
        cost_usd: 0.0021,
      },
    ],
    final: {
      model_alias: "best_reasoning_model",
      provider_model: "best_reasoning_model",
      status: "ok",
      error_reason: null,
    },
  },
});
await telemetry.insertPayload({
  requestId: SEED_TRACE_ID,
  requestJson: JSON.stringify({
    model: "auto",
    messages: [{ role: "user", content: "large payload readback" }],
    user: `${"x".repeat(270_000)}payload-tail`,
  }),
  responseJson: '{"ok":true}',
  createdAt: new Date(),
});

// Close this handle; the server opens its own.
(seedDb as unknown as { $sqlite: Database.Database }).$sqlite.close();

// Coverage opt-in: when V8 coverage is collecting (pnpm test:e2e:coverage), import the
// BUILT gateway so c8 can remap via the on-disk .js.map — tsx transpiles src in-memory
// with no disk sourcemap, which c8 cannot map. A normal e2e run imports src as before.
const { buildServer } = process.env.NODE_V8_COVERAGE
  ? await import("../../dist/server.js")
  : await import("../../src/server.js");
// Boot from a THROWAWAY COPY of the repo-root config dir (fresh each run, like
// the DB above): admin rule edits now WRITE BACK to config/*.yaml (yaml-writeback),
// so e2e admin saves (e.g. the lane edit in admin.spec) must land in the copy —
// never in the checked-in config. The eval e2e additionally raises the effective
// Layer-1 confidence threshold PER REQUEST via the e2e-only
// `x-helm-rules-threshold` header (gated by HELM_E2E) so it reaches Layer-2 eval
// without any config mutation at all — other specs (routing) keep the spec
// default 0.45. See implementation-notes (2026-05-31 · e2e.eval).
const repoConfigDir = new URL("../../../../config", import.meta.url).pathname;
const configDir = `${DATA_DIR}/config`;
cpSync(repoConfigDir, configDir, { recursive: true });
const { app, port, host } = await buildServer({
  configDir,
  // Keep the hermetic gateway independent of host-wide memory pressure. Runtime
  // admission behavior has focused tests; media e2e should exercise routing.
  memoryCoordinator: createRuntimeMemoryCoordinator({
    capacityBytes: () => Number.MAX_SAFE_INTEGER,
  }),
  resourcePressure: {
    shouldRun: async () => true,
    shouldRunHeavy: async () => false,
  },
});
serve({ fetch: app.fetch, port, hostname: host });
process.stdout.write(`e2e gateway listening on ${host}:${port}\n`);

// Coverage opt-in: Playwright hard-kills (SIGKILL) this webServer at teardown, so
// signal/exit handlers never run. Flush V8 coverage PERIODICALLY (cumulative
// snapshots) so the latest snapshot before the kill captures the run; c8 merges them.
if (process.env.NODE_V8_COVERAGE) {
  const { takeCoverage } = await import("node:v8");
  const snap = () => {
    try {
      takeCoverage();
    } catch {
      // best-effort
    }
  };
  setInterval(snap, 300).unref();
  process.on("SIGTERM", () => {
    snap();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    snap();
    process.exit(0);
  });
}
