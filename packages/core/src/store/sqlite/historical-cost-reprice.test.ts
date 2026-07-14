import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEntry } from "@helm/shared";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyHistoricalCostReprice,
  applyHistoricalCostRepriceManifest,
  planHistoricalCostReprice,
} from "./historical-cost-reprice.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function catalogEntry(alias: string, pricing: CatalogEntry["pricing"]): CatalogEntry {
  return {
    modelKey: alias,
    source: "override",
    pricing,
    capabilities: {
      supportsTools: true,
      jsonOutput: "schema",
      supportsVision: false,
      supportsStreaming: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
  };
}

function openFixture(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE telemetry (
      request_id TEXT PRIMARY KEY,
      decision_json TEXT NOT NULL,
      cost_usd REAL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cached_tokens INTEGER,
      cache_creation_tokens INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE oauth_usage (
      provider_id TEXT NOT NULL,
      account TEXT NOT NULL,
      bucket_ms INTEGER NOT NULL,
      cost_usd REAL,
      PRIMARY KEY (provider_id, account, bucket_ms)
    );
  `);
  return db;
}

function decision(alias: string, completionUsd: number | null): Record<string, unknown> {
  return {
    final: { model_alias: alias, status: "ok" },
    provider_attempts: [
      { alias, skipped: false, status: "ok", cost_usd: completionUsd },
      { alias: "failed/fallback", skipped: false, status: "error", cost_usd: null },
    ],
    cost_breakdown: {
      eval_usd: 0.001,
      completion_usd: completionUsd,
      total_usd: completionUsd === null ? 0.001 : completionUsd + 0.001,
    },
    serving_account: null,
  };
}

function insertTelemetry(
  db: Database.Database,
  input: {
    requestId: string;
    alias: string;
    decision?: Record<string, unknown>;
    costUsd?: number | null;
    prompt?: number | null;
    completion?: number | null;
    cached?: number | null;
    cacheCreation?: number | null;
    createdAt?: number;
  },
): void {
  const body = input.decision ?? decision(input.alias, input.costUsd ?? 0.02);
  db.prepare(
    `INSERT INTO telemetry
      (request_id, decision_json, cost_usd, prompt_tokens, completion_tokens,
       cached_tokens, cache_creation_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.requestId,
    JSON.stringify(body),
    input.costUsd ?? 0.021,
    input.prompt ?? 1_000,
    input.completion ?? 100,
    input.cached ?? 200,
    input.cacheCreation === undefined ? 0 : input.cacheCreation,
    input.createdAt ?? 3_700_000,
  );
}

describe("historical cost repricing", () => {
  it("plans exact rows deterministically and reports ambiguous rows by reason", () => {
    const db = openFixture();
    try {
      insertTelemetry(db, { requestId: "deepseek", alias: "deepseek/deepseek-v4-pro" });
      insertTelemetry(db, { requestId: "gpt", alias: "openai/gpt-5.6-sol" });
      const catalog = new Map<string, CatalogEntry>([
        [
          "deepseek/deepseek-v4-pro",
          catalogEntry("deepseek/deepseek-v4-pro", {
            inputPerMTokUsd: 0.435,
            outputPerMTokUsd: 0.87,
            cacheReadPerMTokUsd: 0.003625,
            cacheWritePerMTokUsd: null,
          }),
        ],
        [
          "openai/gpt-5.6-sol",
          catalogEntry("openai/gpt-5.6-sol", {
            inputPerMTokUsd: 5,
            outputPerMTokUsd: 30,
            cacheReadPerMTokUsd: 0.5,
            cacheWritePerMTokUsd: 6.25,
            serviceTiers: {
              priority: { inputPerMTokUsd: 10, outputPerMTokUsd: 60 },
            },
          }),
        ],
      ]);
      const first = planHistoricalCostReprice(db, catalog, "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      const second = planHistoricalCostReprice(db, catalog, "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      expect(first.planSha256).toBe(second.planSha256);
      expect(first.eligibleByAlias).toEqual({ "deepseek/deepseek-v4-pro": 1 });
      expect(first.skippedByReason).toEqual({ missing_service_tier: 1 });
      expect(first.assumptions.standardServiceTier).toBe(0);
      expect(first.evidenceLimitations).toEqual([
        "retained_payload_service_tier_replay_not_implemented",
      ]);
    } finally {
      db.close();
    }
  });

  it("reprices subscription telemetry when the OAuth delta cannot be mapped", () => {
    const db = openFixture();
    try {
      const alias = "anthropic/claude-sonnet-5";
      insertTelemetry(db, { requestId: "no-account", alias });
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
        cacheReadPerMTokUsd: 0.2,
        cacheWritePerMTokUsd: 2.5,
        cacheWrite1hPerMTokUsd: 4,
      });
      const plan = planHistoricalCostReprice(db, new Map([[alias, entry]]), "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      expect(plan.eligible).toBe(1);
      expect(plan.rows[0]?.oauthKey).toBeNull();
      expect(plan.oauthDeltaUnmapped).toBe(1);
      expect(plan.oauthBuckets).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("best-evidence assumes Standard only for direct/subscription GPT aliases", () => {
    const db = openFixture();
    try {
      insertTelemetry(db, {
        requestId: "gpt",
        alias: "openai/gpt-5.6-sol",
        cacheCreation: null,
      });
      const entry = catalogEntry("openai/gpt-5.6-sol", {
        inputPerMTokUsd: 5,
        outputPerMTokUsd: 30,
        cacheReadPerMTokUsd: 0.5,
        cacheWritePerMTokUsd: 6.25,
        serviceTiers: { priority: { inputPerMTokUsd: 10, outputPerMTokUsd: 60 } },
      });
      const exact = planHistoricalCostReprice(
        db,
        new Map([[entry.modelKey, entry]]),
        "pricing-sha",
        { fromMs: 0, toMs: 10_000_000 },
      );
      expect(exact.eligible).toBe(0);
      expect(exact.skippedByReason).toEqual({ missing_cache_partition: 1 });

      const plan = planHistoricalCostReprice(
        db,
        new Map([[entry.modelKey, entry]]),
        "pricing-sha",
        { fromMs: 0, toMs: 10_000_000, mode: "best-evidence" },
      );
      expect(plan.eligible).toBe(1);
      expect(plan.assumptions.standardServiceTier).toBe(1);
      expect(plan.assumptions.zeroCacheCreation).toBe(1);
      expect(plan.rows[0]?.assumedStandardTier).toBe(true);
      expect(plan.rows[0]?.assumedZeroCacheCreation).toBe(true);
    } finally {
      db.close();
    }
  });

  it("uses persisted detailed usage evidence and preserves authoritative billed rows", () => {
    const db = openFixture();
    try {
      const alias = "openai/gpt-5.6-sol";
      const priority = decision(alias, 0.02);
      const priorityUsage = {
        prompt_tokens: 1_000,
        completion_tokens: 100,
        cached_tokens: 200,
        cache_creation_tokens: 0,
        service_tier: "priority",
        cache_creation_5m_tokens: null,
        cache_creation_1h_tokens: null,
        audio_prompt_tokens: null,
        cached_audio_prompt_tokens: null,
        image_output_tokens: null,
        billed_cost_usd: null,
      };
      priority.usage = priorityUsage;
      insertTelemetry(db, { requestId: "priority", alias, decision: priority });
      const billed = decision(alias, 0.02);
      billed.usage = { ...priorityUsage, billed_cost_usd: 0.123 };
      insertTelemetry(db, { requestId: "billed", alias, decision: billed });
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 5,
        outputPerMTokUsd: 30,
        cacheReadPerMTokUsd: 0.5,
        cacheWritePerMTokUsd: 6.25,
        serviceTiers: {
          priority: {
            inputPerMTokUsd: 10,
            outputPerMTokUsd: 60,
            cacheReadPerMTokUsd: 1,
            cacheWritePerMTokUsd: 12.5,
          },
        },
      });
      const plan = planHistoricalCostReprice(db, new Map([[alias, entry]]), "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      expect(plan.eligible).toBe(1);
      expect(plan.rows[0]?.assumedStandardTier).toBe(false);
      expect(plan.skippedByReason).toEqual({ authoritative_billed_cost: 1 });
    } finally {
      db.close();
    }
  });

  it("uses exact Anthropic inference geography and scopes global assumptions to best-evidence", () => {
    const db = openFixture();
    try {
      const alias = "anthropic/claude-sonnet-5";
      const us = decision(alias, 0.02);
      us.usage = {
        prompt_tokens: 1_000,
        completion_tokens: 100,
        cached_tokens: 200,
        cache_creation_tokens: 0,
        service_tier: null,
        inference_geo: "us",
        cache_creation_5m_tokens: 0,
        cache_creation_1h_tokens: 0,
        audio_prompt_tokens: null,
        cached_audio_prompt_tokens: null,
        image_output_tokens: null,
        billed_cost_usd: null,
      };
      insertTelemetry(db, { requestId: "us", alias, decision: us });
      insertTelemetry(db, { requestId: "missing-geo", alias });
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
        cacheReadPerMTokUsd: 0.2,
        cacheWritePerMTokUsd: 2.5,
        cacheWrite1hPerMTokUsd: 4,
        inferenceGeoMultipliers: { global: 1, us: 1.1 },
      });
      const catalog = new Map([[alias, entry]]);

      const exact = planHistoricalCostReprice(db, catalog, "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      expect(exact.eligible).toBe(1);
      expect(exact.skippedByReason).toEqual({ missing_inference_geo: 1 });
      expect(exact.rows[0]?.newCompletionUsd).toBeCloseTo(0.002904, 12);
      expect(exact.rows[0]?.assumedGlobalInferenceGeo).toBe(false);

      const bestEvidence = planHistoricalCostReprice(db, catalog, "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
        mode: "best-evidence",
      });
      expect(bestEvidence.eligible).toBe(2);
      expect(bestEvidence.assumptions.globalInferenceGeo).toBe(1);
      expect(
        bestEvidence.rows.find((row) => row.requestId === "missing-geo")?.assumedGlobalInferenceGeo,
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("applies conditional telemetry and delta-only OAuth updates after a targeted backup", () => {
    const db = openFixture();
    const dir = mkdtempSync(join(tmpdir(), "helm-cost-reprice-"));
    dirs.push(dir);
    const backupPath = join(dir, "backup.sqlite");
    try {
      const alias = "anthropic/claude-sonnet-5";
      const body = decision(alias, 0.02);
      body.serving_account = { provider_id: "anthropic", account: "acct" };
      insertTelemetry(db, { requestId: "r1", alias, decision: body });
      db.prepare(
        "INSERT INTO oauth_usage (provider_id, account, bucket_ms, cost_usd) VALUES (?, ?, ?, ?)",
      ).run("anthropic", "acct", 3_600_000, 1);
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
        cacheReadPerMTokUsd: 0.2,
        cacheWritePerMTokUsd: 2.5,
        cacheWrite1hPerMTokUsd: 4,
      });
      const catalog = new Map([[alias, entry]]);
      const dryRun = planHistoricalCostReprice(db, catalog, "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      const applied = applyHistoricalCostReprice(db, catalog, "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
        expectedPlanSha256: dryRun.planSha256,
        backupPath,
      });
      expect(applied.eligible).toBe(1);
      const stored = db.prepare("SELECT decision_json, cost_usd FROM telemetry").get() as {
        decision_json: string;
        cost_usd: number;
      };
      const storedDecision = JSON.parse(stored.decision_json) as Record<string, unknown>;
      const attempts = storedDecision.provider_attempts as Array<Record<string, unknown>>;
      expect(attempts[1]?.cost_usd).toBeNull();
      expect(stored.cost_usd).toBeCloseTo(applied.rows[0]?.newTotalUsd ?? 0, 12);
      const oauth = db.prepare("SELECT cost_usd FROM oauth_usage").get() as { cost_usd: number };
      expect(oauth.cost_usd).toBeCloseTo(
        1 + (applied.rows[0]?.newCompletionUsd ?? 0) - (applied.rows[0]?.oldCompletionUsd ?? 0),
        12,
      );
      expect(readFileSync(backupPath).byteLength).toBeGreaterThan(0);

      const rerun = planHistoricalCostReprice(db, catalog, "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      expect(rerun.eligible).toBe(0);
      expect(rerun.unchanged).toBe(1);
    } finally {
      db.close();
    }
  });

  it("applies a manifest in bounded batches and resumes from its checkpoint", () => {
    const db = openFixture();
    const dir = mkdtempSync(join(tmpdir(), "helm-cost-reprice-gradual-"));
    dirs.push(dir);
    const checkpointPath = join(dir, "progress.json");
    const backupDir = join(dir, "backups");
    try {
      const alias = "anthropic/claude-sonnet-5";
      for (let index = 0; index < 5; index += 1) {
        const body = decision(alias, 0.02);
        body.serving_account = { provider_id: "anthropic", account: "acct" };
        insertTelemetry(db, { requestId: `r${index}`, alias, decision: body });
      }
      db.prepare(
        "INSERT INTO oauth_usage (provider_id, account, bucket_ms, cost_usd) VALUES (?, ?, ?, ?)",
      ).run("anthropic", "acct", 3_600_000, 1);
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
        cacheReadPerMTokUsd: 0.2,
        cacheWritePerMTokUsd: 2.5,
        cacheWrite1hPerMTokUsd: 4,
      });
      const manifest = planHistoricalCostReprice(db, new Map([[alias, entry]]), "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      const rowDelta =
        (manifest.rows[0]?.newCompletionUsd ?? 0) - (manifest.rows[0]?.oldCompletionUsd ?? 0);

      const first = applyHistoricalCostRepriceManifest(db, manifest, {
        checkpointPath,
        backupDir,
        batchSize: 2,
        maxBatches: 1,
        batchDelayMs: 0,
      });
      expect(first.nextRowIndex).toBe(2);
      expect(first.completed).toBe(false);
      expect(first.lastBatch?.mutatedRows).toBe(2);
      expect(
        (db.prepare("SELECT cost_usd FROM oauth_usage").get() as { cost_usd: number }).cost_usd,
      ).toBeCloseTo(1 + 2 * rowDelta, 12);

      const second = applyHistoricalCostRepriceManifest(db, manifest, {
        checkpointPath,
        backupDir,
        batchSize: 2,
        maxBatches: 1,
        batchDelayMs: 0,
      });
      expect(second.nextRowIndex).toBe(4);
      expect(second.completed).toBe(false);

      const third = applyHistoricalCostRepriceManifest(db, manifest, {
        checkpointPath,
        backupDir,
        batchSize: 2,
        maxBatches: 1,
        batchDelayMs: 0,
      });
      expect(third.nextRowIndex).toBe(5);
      expect(third.completed).toBe(true);
      expect(third.appliedRows).toBe(5);
      expect(
        (db.prepare("SELECT cost_usd FROM oauth_usage").get() as { cost_usd: number }).cost_usd,
      ).toBeCloseTo(1 + 5 * rowDelta, 12);
      const backups = readdirSync(backupDir);
      expect(backups).toHaveLength(3);
      for (const name of backups) {
        const backup = new Database(join(backupDir, name), { readonly: true });
        try {
          expect(backup.pragma("quick_check", { simple: true })).toBe("ok");
        } finally {
          backup.close();
        }
      }
    } finally {
      db.close();
    }
  });

  it("detects an already committed batch after checkpoint interruption without double counting", () => {
    const db = openFixture();
    const dir = mkdtempSync(join(tmpdir(), "helm-cost-reprice-interrupted-"));
    dirs.push(dir);
    const checkpointPath = join(dir, "progress.json");
    const backupDir = join(dir, "backups");
    try {
      const alias = "anthropic/claude-sonnet-5";
      for (let index = 0; index < 2; index += 1) {
        const body = decision(alias, 0.02);
        body.serving_account = { provider_id: "anthropic", account: "acct" };
        insertTelemetry(db, { requestId: `r${index}`, alias, decision: body });
      }
      db.prepare(
        "INSERT INTO oauth_usage (provider_id, account, bucket_ms, cost_usd) VALUES (?, ?, ?, ?)",
      ).run("anthropic", "acct", 3_600_000, 1);
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
        cacheReadPerMTokUsd: 0.2,
        cacheWritePerMTokUsd: 2.5,
        cacheWrite1hPerMTokUsd: 4,
      });
      const manifest = planHistoricalCostReprice(db, new Map([[alias, entry]]), "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      const applied = applyHistoricalCostRepriceManifest(db, manifest, {
        checkpointPath,
        backupDir,
        batchSize: 2,
        maxBatches: 1,
        batchDelayMs: 0,
      });
      const oauthAfterCommit = (
        db.prepare("SELECT cost_usd FROM oauth_usage").get() as { cost_usd: number }
      ).cost_usd;
      writeFileSync(
        checkpointPath,
        `${JSON.stringify({ ...applied, nextRowIndex: 0, completed: false })}\n`,
      );

      const resumed = applyHistoricalCostRepriceManifest(db, manifest, {
        checkpointPath,
        backupDir,
        batchSize: 2,
        maxBatches: 1,
        batchDelayMs: 0,
      });
      expect(resumed.completed).toBe(true);
      expect(resumed.lastBatch?.mutatedRows).toBe(0);
      expect(resumed.lastBatch?.alreadyAppliedRows).toBe(2);
      expect(
        (db.prepare("SELECT cost_usd FROM oauth_usage").get() as { cost_usd: number }).cost_usd,
      ).toBe(oauthAfterCommit);
    } finally {
      db.close();
    }
  });

  it("rolls back the whole batch when an OAuth delta update fails", () => {
    const db = openFixture();
    const dir = mkdtempSync(join(tmpdir(), "helm-cost-reprice-rollback-"));
    dirs.push(dir);
    const checkpointPath = join(dir, "progress.json");
    const backupDir = join(dir, "backups");
    try {
      const alias = "anthropic/claude-sonnet-5";
      const body = decision(alias, 0.02);
      body.serving_account = { provider_id: "anthropic", account: "acct" };
      insertTelemetry(db, { requestId: "r1", alias, decision: body });
      db.prepare(
        "INSERT INTO oauth_usage (provider_id, account, bucket_ms, cost_usd) VALUES (?, ?, ?, ?)",
      ).run("anthropic", "acct", 3_600_000, 1);
      db.exec(`
        CREATE TRIGGER fail_oauth_update BEFORE UPDATE ON oauth_usage
        BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END;
      `);
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
        cacheReadPerMTokUsd: 0.2,
        cacheWritePerMTokUsd: 2.5,
        cacheWrite1hPerMTokUsd: 4,
      });
      const manifest = planHistoricalCostReprice(db, new Map([[alias, entry]]), "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });

      expect(() =>
        applyHistoricalCostRepriceManifest(db, manifest, {
          checkpointPath,
          backupDir,
          batchSize: 1,
          maxBatches: 1,
          batchDelayMs: 0,
        }),
      ).toThrow("simulated interruption");
      const stored = db.prepare("SELECT decision_json, cost_usd FROM telemetry").get() as {
        decision_json: string;
        cost_usd: number;
      };
      expect(stored.cost_usd).toBeCloseTo(0.021, 12);
      expect(
        (
          (JSON.parse(stored.decision_json) as ParsedDecisionForTest).provider_attempts?.[0] as {
            cost_usd: number;
          }
        ).cost_usd,
      ).toBeCloseTo(0.02, 12);
      expect(
        (db.prepare("SELECT cost_usd FROM oauth_usage").get() as { cost_usd: number }).cost_usd,
      ).toBe(1);
      expect(existsSync(checkpointPath)).toBe(false);
      expect(readdirSync(backupDir)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("rejects a row whose old values no longer match the manifest", () => {
    const db = openFixture();
    const dir = mkdtempSync(join(tmpdir(), "helm-cost-reprice-conflict-"));
    dirs.push(dir);
    try {
      const alias = "deepseek/deepseek-v4-pro";
      insertTelemetry(db, { requestId: "r1", alias });
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 0.435,
        outputPerMTokUsd: 0.87,
        cacheReadPerMTokUsd: 0.003625,
        cacheWritePerMTokUsd: null,
      });
      const manifest = planHistoricalCostReprice(db, new Map([[alias, entry]]), "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      db.prepare("UPDATE telemetry SET cost_usd = ? WHERE request_id = ?").run(9, "r1");

      expect(() =>
        applyHistoricalCostRepriceManifest(db, manifest, {
          checkpointPath: join(dir, "progress.json"),
          backupDir: join(dir, "backups"),
          batchSize: 1,
          maxBatches: 1,
          batchDelayMs: 0,
        }),
      ).toThrow("old values no longer match manifest: r1");
    } finally {
      db.close();
    }
  });

  it("aborts before backup or mutation when health, WAL, or free-disk guards fail", () => {
    const db = openFixture();
    const dir = mkdtempSync(join(tmpdir(), "helm-cost-reprice-guards-"));
    dirs.push(dir);
    try {
      const alias = "deepseek/deepseek-v4-pro";
      insertTelemetry(db, { requestId: "r1", alias });
      const entry = catalogEntry(alias, {
        inputPerMTokUsd: 0.435,
        outputPerMTokUsd: 0.87,
        cacheReadPerMTokUsd: 0.003625,
        cacheWritePerMTokUsd: null,
      });
      const manifest = planHistoricalCostReprice(db, new Map([[alias, entry]]), "pricing-sha", {
        fromMs: 0,
        toMs: 10_000_000,
      });
      const databasePath = join(dir, "helm.db");
      writeFileSync(databasePath, "");

      expect(() =>
        applyHistoricalCostRepriceManifest(db, manifest, {
          checkpointPath: join(dir, "health-progress.json"),
          backupDir: join(dir, "health-backups"),
          databasePath,
          healthCheck: () => {
            throw new Error("health check failed");
          },
        }),
      ).toThrow("health check failed");

      writeFileSync(`${databasePath}-wal`, "too-large");
      expect(() =>
        applyHistoricalCostRepriceManifest(db, manifest, {
          checkpointPath: join(dir, "wal-progress.json"),
          backupDir: join(dir, "wal-backups"),
          databasePath,
          maxWalBytes: 4,
          minFreeBytes: 1,
        }),
      ).toThrow("WAL safety limit exceeded");
      rmSync(`${databasePath}-wal`);

      expect(() =>
        applyHistoricalCostRepriceManifest(db, manifest, {
          checkpointPath: join(dir, "disk-progress.json"),
          backupDir: join(dir, "disk-backups"),
          databasePath,
          maxWalBytes: 1,
          minFreeBytes: Number.MAX_SAFE_INTEGER,
        }),
      ).toThrow("free disk safety limit breached");
      expect(db.prepare("SELECT cost_usd FROM telemetry").pluck().get()).toBeCloseTo(0.021, 12);
      expect(readdirSync(dir).filter((name) => name.endsWith("backups"))).toEqual([]);
    } finally {
      db.close();
    }
  });
});

interface ParsedDecisionForTest {
  provider_attempts?: Array<Record<string, unknown>>;
}
