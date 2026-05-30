// e2e launcher: boots a real gateway with a deterministic, pre-seeded API key so
// tests don't have to scrape the bootstrap log. Provider base_url points at the
// local mock upstream. Offline + deterministic.

import { mkdirSync, rmSync } from "node:fs";
import { hashKey } from "@helm/core";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";

const TEST_KEY = process.env.HELM_TEST_KEY ?? "helm_live_e2e_testkey";
const DATA_DIR = process.env.HELM_DATA_DIR ?? "./.e2e-data";
const DB_PATH = `${DATA_DIR}/helm.db`;

// Fresh data dir each run so the seeded key is the only one (and bootstrap is a
// no-op because a key already exists).
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

const { createSqliteDb, SqliteKeyStore } = await import("@helm/core");
const seedDb = createSqliteDb(DB_PATH);
const keyStore = new SqliteKeyStore(seedDb);
await keyStore.createKey({
  keyId: "k_e2e",
  hash: hashKey(TEST_KEY),
  prefix: "helm_live_e2e",
  accountId: "acct_e2e",
  role: "root",
});
// Close this handle; the server opens its own.
(seedDb as unknown as { $sqlite: Database.Database }).$sqlite.close();

const { buildServer } = await import("../../src/server.js");
// Resolve the repo-root config dir regardless of cwd. The eval e2e raises the
// effective Layer-1 confidence threshold PER REQUEST via the e2e-only
// `x-helm-rules-threshold` header (gated by HELM_E2E) so it reaches Layer-2 eval
// WITHOUT mutating the checked-in config — other specs (routing) keep the spec
// default 0.45. See implementation-notes (2026-05-31 · e2e.eval).
const configDir = new URL("../../../../config", import.meta.url).pathname;
const { app, port, host } = buildServer({ configDir });
serve({ fetch: app.fetch, port, hostname: host });
process.stdout.write(`e2e gateway listening on ${host}:${port}\n`);
