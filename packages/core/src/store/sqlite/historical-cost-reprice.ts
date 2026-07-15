import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogEntry } from "@helm/shared";
import Database from "better-sqlite3";
import { computeCostUsd } from "../../catalog/cost.js";
import { loadRuntimeCatalog } from "../../catalog/load.js";

// Operator-only historical repair tool. Dry-run is the default:
//   pnpm pricing:reprice -- --db ./data/helm.db --pricing ./config/pricing.yaml \
//     --from-ms 0 --to-ms 1 --manifest ./plan.json
// Recommended gradual apply reads that manifest once, defaults to one batch of
// 100 rows, and resumes from an atomic checkpoint without rescanning telemetry:
//   ... --apply-manifest ./plan.json --expected-plan-sha256 <sha256> \
//     --health-url https://host/healthz
// The CLI rejects legacy --apply because a whole-window write transaction is
// unsafe for a large live database. The exported function remains for tests and
// recovery compatibility only.
// Never run this as a startup migration: it intentionally needs an explicit,
// bounded window and operator acknowledgement of any best-evidence assumptions.

export type HistoricalCostRepriceMode = "exact" | "best-evidence";

export interface HistoricalCostRepriceOptions {
  fromMs: number;
  toMs: number;
  mode?: HistoricalCostRepriceMode;
}

interface TelemetryRow {
  request_id: string;
  decision_json: string;
  cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cache_creation_tokens: number | null;
  created_at: number;
}

interface OAuthRow {
  provider_id: string;
  account: string;
  bucket_ms: number;
  cost_usd: number | null;
}

interface PlannedRow {
  requestId: string;
  alias: string;
  createdAt: number;
  attemptIndex: number;
  oldCompletionUsd: number | null;
  newCompletionUsd: number;
  oldTotalUsd: number | null;
  newTotalUsd: number;
  assumedStandardTier: boolean;
  assumedZeroCacheCreation: boolean;
  assumedGlobalInferenceGeo: boolean;
  oauthKey: string | null;
}

export interface HistoricalCostRepriceCheckpoint {
  version: 1;
  planSha256: string;
  pricingSha256: string;
  totalRows: number;
  nextRowIndex: number;
  appliedRows: number;
  alreadyAppliedRows: number;
  batchesApplied: number;
  completed: boolean;
  lastBatch: {
    startRowIndex: number;
    endRowIndex: number;
    mutatedRows: number;
    alreadyAppliedRows: number;
    oauthBucketsUpdated: number;
    backupPath: string | null;
  } | null;
}

export interface HistoricalCostManifestApplyOptions {
  checkpointPath: string;
  backupDir: string;
  batchSize?: number;
  maxBatches?: number;
  batchDelayMs?: number;
  databasePath?: string;
  maxWalBytes?: number;
  minFreeBytes?: number;
  healthCheck?: () => void;
}

export interface HistoricalCostRepriceManifest {
  version: 1;
  mode: HistoricalCostRepriceMode;
  fromMs: number;
  toMs: number;
  pricingSha256: string;
  eligible: number;
  unchanged: number;
  skipped: number;
  eligibleByAlias: Record<string, number>;
  skippedByReason: Record<string, number>;
  skippedByAlias: Record<string, Record<string, number>>;
  assumptions: {
    standardServiceTier: number;
    zeroCacheCreation: number;
    globalInferenceGeo: number;
  };
  oauthDeltaUnmapped: number;
  evidenceLimitations: ["retained_payload_service_tier_replay_not_implemented"];
  totals: {
    oldCompletionUsd: number;
    newCompletionUsd: number;
    oldTotalUsd: number;
    newTotalUsd: number;
  };
  oauthBuckets: Array<{
    providerId: string;
    account: string;
    bucketMs: number;
    completionDeltaUsd: number;
  }>;
  rows: PlannedRow[];
  planSha256: string;
}

export interface HistoricalCostRepriceVerification {
  verifiedRows: number;
  totalUsd: number;
}

interface DecisionAttempt extends Record<string, unknown> {
  alias?: unknown;
  skipped?: unknown;
  status?: unknown;
  cost_usd?: unknown;
}

interface ParsedDecision extends Record<string, unknown> {
  final?: unknown;
  provider_attempts?: unknown;
  cost_breakdown?: unknown;
  serving_account?: unknown;
  usage?: unknown;
}

interface ResolvedUsageEvidence {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
  cacheCreationPromptTokens: number | null;
  cacheCreation5mPromptTokens: number | null;
  cacheCreation1hPromptTokens: number | null;
  audioPromptTokens: number | null;
  cachedAudioPromptTokens: number | null;
  imageOutputTokens: number | null;
  serviceTier: string | null;
  inferenceGeo: string | null;
  billedCostUsd: number | null;
}

const HOUR_MS = 3_600_000;
const EPSILON = 1e-12;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 1;
const DEFAULT_BATCH_DELAY_MS = 5_000;
const DEFAULT_MAX_WAL_BYTES = 1024 ** 3;
const DEFAULT_MIN_FREE_BYTES = 10 * 1024 ** 3;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function usageEvidence(decision: ParsedDecision, row: TelemetryRow): ResolvedUsageEvidence {
  const usage = object(decision.usage);
  if (usage === null) {
    return {
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cachedPromptTokens: row.cached_tokens,
      cacheCreationPromptTokens: row.cache_creation_tokens,
      cacheCreation5mPromptTokens: null,
      cacheCreation1hPromptTokens: null,
      audioPromptTokens: null,
      cachedAudioPromptTokens: null,
      imageOutputTokens: null,
      serviceTier: null,
      inferenceGeo: null,
      billedCostUsd: null,
    };
  }
  return {
    promptTokens: nonnegativeInteger(usage.prompt_tokens),
    completionTokens: nonnegativeInteger(usage.completion_tokens),
    cachedPromptTokens: nonnegativeInteger(usage.cached_tokens),
    cacheCreationPromptTokens: nonnegativeInteger(usage.cache_creation_tokens),
    cacheCreation5mPromptTokens: nonnegativeInteger(usage.cache_creation_5m_tokens),
    cacheCreation1hPromptTokens: nonnegativeInteger(usage.cache_creation_1h_tokens),
    audioPromptTokens: nonnegativeInteger(usage.audio_prompt_tokens),
    cachedAudioPromptTokens: nonnegativeInteger(usage.cached_audio_prompt_tokens),
    imageOutputTokens: nonnegativeInteger(usage.image_output_tokens),
    serviceTier: typeof usage.service_tier === "string" ? usage.service_tier : null,
    inferenceGeo: typeof usage.inference_geo === "string" ? usage.inference_geo : null,
    billedCostUsd: finite(usage.billed_cost_usd),
  };
}

function count(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function sortedRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedNestedRecord(
  input: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Object.entries(input)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, sortedRecord(value)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function oauthKey(providerId: string, account: string, bucketMs: number): string {
  return `${providerId}\u0000${account}\u0000${bucketMs}`;
}

function parseOAuthKey(key: string): { providerId: string; account: string; bucketMs: number } {
  const [providerId = "", account = "", bucket = "0"] = key.split("\u0000");
  return { providerId, account, bucketMs: Number(bucket) };
}

function isRelayAlias(alias: string): boolean {
  return (
    alias.startsWith("openrouter/") ||
    alias.startsWith("zenmux/") ||
    alias.startsWith("zenmux-") ||
    alias === "gpt-image-2" ||
    alias.startsWith("gemini-")
  );
}

function isSubscriptionAlias(alias: string): boolean {
  return (
    alias.startsWith("anthropic/") || alias.startsWith("openai-codex/") || alias.startsWith("xai/")
  );
}

function mayAssumeStandardGpt(alias: string, mode: HistoricalCostRepriceMode): boolean {
  return (
    mode === "best-evidence" &&
    (alias.startsWith("openai/gpt-") || alias.startsWith("openai-codex/gpt-"))
  );
}

function mayAssumeGlobalAnthropic(alias: string, mode: HistoricalCostRepriceMode): boolean {
  return mode === "best-evidence" && alias.startsWith("anthropic/");
}

function classifyPricingAmbiguity(
  alias: string,
  entry: CatalogEntry,
  usage: ResolvedUsageEvidence,
  mode: HistoricalCostRepriceMode,
): {
  reason: string | null;
  assumedStandardTier: boolean;
  assumedZeroCacheCreation: boolean;
  assumedGlobalInferenceGeo: boolean;
} {
  const answer = (
    reason: string | null,
    assumedStandardTier = false,
    assumedZeroCacheCreation = false,
    assumedGlobalInferenceGeo = false,
  ): {
    reason: string | null;
    assumedStandardTier: boolean;
    assumedZeroCacheCreation: boolean;
    assumedGlobalInferenceGeo: boolean;
  } => ({
    reason,
    assumedStandardTier,
    assumedZeroCacheCreation,
    assumedGlobalInferenceGeo,
  });
  const pricing = entry.pricing;
  if (usage.billedCostUsd !== null) {
    return answer("authoritative_billed_cost");
  }
  if (pricing.inputPerMTokUsd === null || pricing.outputPerMTokUsd === null) {
    return answer("unpublished_pricing");
  }
  if (isRelayAlias(alias)) return answer("relay_billed_cost_not_repriceable");
  if (usage.promptTokens === null || usage.completionTokens === null) {
    return answer("missing_token_totals");
  }
  if (
    pricing.cacheReadPerMTokUsd !== null &&
    pricing.cacheReadPerMTokUsd !== pricing.inputPerMTokUsd &&
    usage.cachedPromptTokens === null
  ) {
    return answer("missing_cache_partition");
  }
  const assumedZeroCacheCreation =
    usage.cacheCreationPromptTokens === null && mayAssumeStandardGpt(alias, mode);
  if (
    (pricing.cacheWritePerMTokUsd !== null || pricing.cacheWrite1hPerMTokUsd != null) &&
    usage.cacheCreationPromptTokens === null &&
    !assumedZeroCacheCreation
  ) {
    return answer("missing_cache_partition");
  }
  if ((usage.cacheCreationPromptTokens ?? 0) > 0 && pricing.cacheWrite1hPerMTokUsd != null) {
    if (
      usage.cacheCreation5mPromptTokens === null ||
      usage.cacheCreation1hPromptTokens === null ||
      usage.cacheCreation5mPromptTokens + usage.cacheCreation1hPromptTokens !==
        usage.cacheCreationPromptTokens
    ) {
      return answer("missing_anthropic_cache_ttl");
    }
  }
  if (
    pricing.imageOutputPerMTokUsd != null &&
    pricing.imageOutputPerMTokUsd !== pricing.outputPerMTokUsd &&
    usage.completionTokens > 0 &&
    usage.imageOutputTokens === null
  ) {
    return answer("missing_gemini_modality_partition");
  }
  if (
    pricing.audioInputPerMTokUsd != null &&
    pricing.audioInputPerMTokUsd !== pricing.inputPerMTokUsd &&
    usage.promptTokens > 0 &&
    usage.audioPromptTokens === null
  ) {
    return answer("missing_gemini_modality_partition");
  }
  let assumedGlobalInferenceGeo = false;
  if (
    pricing.inferenceGeoMultipliers !== undefined &&
    Object.keys(pricing.inferenceGeoMultipliers).length > 0
  ) {
    const inferenceGeo = usage.inferenceGeo?.trim().toLowerCase();
    if (inferenceGeo !== undefined) {
      if (pricing.inferenceGeoMultipliers[inferenceGeo] === undefined) {
        return answer("unknown_inference_geo");
      }
    } else if (mayAssumeGlobalAnthropic(alias, mode)) {
      assumedGlobalInferenceGeo = true;
    } else {
      return answer("missing_inference_geo");
    }
  }
  if (pricing.serviceTiers !== undefined && Object.keys(pricing.serviceTiers).length > 0) {
    const namedTier = usage.serviceTier?.toLowerCase();
    if (
      namedTier !== undefined &&
      !["auto", "default", "standard", "unspecified"].includes(namedTier)
    ) {
      return pricing.serviceTiers[namedTier] !== undefined
        ? answer(null, false, assumedZeroCacheCreation, assumedGlobalInferenceGeo)
        : answer("unknown_service_tier");
    }
    if (namedTier !== undefined)
      return answer(null, false, assumedZeroCacheCreation, assumedGlobalInferenceGeo);
    const assumedStandardTier = mayAssumeStandardGpt(alias, mode);
    return assumedStandardTier
      ? answer(null, true, assumedZeroCacheCreation, assumedGlobalInferenceGeo)
      : answer("missing_service_tier");
  }
  return answer(null, false, assumedZeroCacheCreation, assumedGlobalInferenceGeo);
}

function stablePlanPayload(manifest: Omit<HistoricalCostRepriceManifest, "planSha256">): string {
  return JSON.stringify(manifest);
}

export function planHistoricalCostReprice(
  db: Database.Database,
  catalog: ReadonlyMap<string, CatalogEntry>,
  pricingSha256: string,
  options: HistoricalCostRepriceOptions,
): HistoricalCostRepriceManifest {
  const mode = options.mode ?? "exact";
  if (!Number.isSafeInteger(options.fromMs) || !Number.isSafeInteger(options.toMs)) {
    throw new Error("fromMs and toMs must be safe integer epoch milliseconds");
  }
  if (options.fromMs >= options.toMs) throw new Error("fromMs must be less than toMs");

  const rows = db
    .prepare(
      `SELECT request_id, decision_json, cost_usd, prompt_tokens, completion_tokens,
              cached_tokens, cache_creation_tokens, created_at
         FROM telemetry
        WHERE created_at >= ? AND created_at < ?
        ORDER BY request_id`,
    )
    .iterate(options.fromMs, options.toMs) as IterableIterator<TelemetryRow>;
  const oauthRows = db
    .prepare(
      `SELECT provider_id, account, bucket_ms, cost_usd FROM oauth_usage
        WHERE bucket_ms >= ? AND bucket_ms < ?`,
    )
    .all(
      Math.floor(options.fromMs / HOUR_MS) * HOUR_MS,
      Math.ceil(options.toMs / HOUR_MS) * HOUR_MS,
    ) as OAuthRow[];
  const oauthExisting = new Set(
    oauthRows.map((row) => oauthKey(row.provider_id, row.account, row.bucket_ms)),
  );

  const eligibleByAlias: Record<string, number> = {};
  const skippedByReason: Record<string, number> = {};
  const skippedByAlias: Record<string, Record<string, number>> = {};
  const planned: PlannedRow[] = [];
  const oauthDeltas = new Map<string, number>();
  let unchanged = 0;
  let standardAssumptions = 0;
  let zeroCacheCreationAssumptions = 0;
  let globalInferenceGeoAssumptions = 0;
  let oauthDeltaUnmapped = 0;

  const skip = (alias: string, reason: string): void => {
    count(skippedByReason, reason);
    const byReason = skippedByAlias[alias] ?? {};
    count(byReason, reason);
    skippedByAlias[alias] = byReason;
  };

  for (const row of rows) {
    let decision: ParsedDecision;
    try {
      decision = JSON.parse(row.decision_json) as ParsedDecision;
    } catch {
      skip("<invalid>", "invalid_decision_json");
      continue;
    }
    const final = object(decision.final);
    const alias = typeof final?.model_alias === "string" ? final.model_alias : "<unknown>";
    if (final?.status !== "ok") {
      skip(alias, "request_not_successful");
      continue;
    }
    const entry = catalog.get(alias);
    if (entry === undefined) {
      skip(alias, "pricing_entry_missing");
      continue;
    }
    const evidence = usageEvidence(decision, row);
    const ambiguity = classifyPricingAmbiguity(alias, entry, evidence, mode);
    if (ambiguity.reason !== null) {
      skip(alias, ambiguity.reason);
      continue;
    }
    const attempts = Array.isArray(decision.provider_attempts)
      ? (decision.provider_attempts as DecisionAttempt[])
      : [];
    const successful = attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(
        ({ attempt }) =>
          attempt.alias === alias && attempt.status === "ok" && attempt.skipped !== true,
      );
    if (successful.length !== 1) {
      skip(alias, "served_attempt_not_unique");
      continue;
    }
    const usage = {
      promptTokens: evidence.promptTokens ?? undefined,
      completionTokens: evidence.completionTokens ?? undefined,
      cachedPromptTokens: evidence.cachedPromptTokens ?? undefined,
      cacheCreationPromptTokens:
        evidence.cacheCreationPromptTokens ?? (ambiguity.assumedZeroCacheCreation ? 0 : undefined),
      cacheCreation5mPromptTokens: evidence.cacheCreation5mPromptTokens ?? undefined,
      cacheCreation1hPromptTokens: evidence.cacheCreation1hPromptTokens ?? undefined,
      audioPromptTokens: evidence.audioPromptTokens ?? undefined,
      cachedAudioPromptTokens: evidence.cachedAudioPromptTokens ?? undefined,
      imageOutputTokens: evidence.imageOutputTokens ?? undefined,
      serviceTier: evidence.serviceTier ?? undefined,
      inferenceGeo:
        evidence.inferenceGeo ?? (ambiguity.assumedGlobalInferenceGeo ? "global" : undefined),
    };
    const newCompletionUsd = computeCostUsd(entry.pricing, usage);
    if (newCompletionUsd === null) {
      skip(alias, "cost_not_exactly_computable");
      continue;
    }
    const breakdown = object(decision.cost_breakdown);
    const evalUsd = finite(breakdown?.eval_usd);
    const oldCompletionUsd =
      finite(breakdown?.completion_usd) ?? finite(successful[0]?.attempt.cost_usd);
    const oldTotalUsd = finite(breakdown?.total_usd) ?? row.cost_usd;
    const newTotalUsd = (evalUsd ?? 0) + newCompletionUsd;

    const completionDelta = newCompletionUsd - (oldCompletionUsd ?? 0);
    const totalDelta = newTotalUsd - (oldTotalUsd ?? 0);
    if (Math.abs(completionDelta) <= EPSILON && Math.abs(totalDelta) <= EPSILON) {
      unchanged += 1;
      continue;
    }
    let rowOauthKey: string | null = null;
    const servingAccount = object(decision.serving_account);
    if (isSubscriptionAlias(alias)) {
      if (
        typeof servingAccount?.provider_id === "string" &&
        typeof servingAccount.account === "string"
      ) {
        const candidateOauthKey = oauthKey(
          servingAccount.provider_id,
          servingAccount.account,
          Math.floor(row.created_at / HOUR_MS) * HOUR_MS,
        );
        if (oauthExisting.has(candidateOauthKey)) rowOauthKey = candidateOauthKey;
      }
      if (rowOauthKey === null && Math.abs(completionDelta) > EPSILON) oauthDeltaUnmapped += 1;
    }
    count(eligibleByAlias, alias);
    if (ambiguity.assumedStandardTier) standardAssumptions += 1;
    if (ambiguity.assumedZeroCacheCreation) zeroCacheCreationAssumptions += 1;
    if (ambiguity.assumedGlobalInferenceGeo) globalInferenceGeoAssumptions += 1;
    planned.push({
      requestId: row.request_id,
      alias,
      createdAt: row.created_at,
      attemptIndex: successful[0]?.index ?? 0,
      oldCompletionUsd,
      newCompletionUsd,
      oldTotalUsd,
      newTotalUsd,
      assumedStandardTier: ambiguity.assumedStandardTier,
      assumedZeroCacheCreation: ambiguity.assumedZeroCacheCreation,
      assumedGlobalInferenceGeo: ambiguity.assumedGlobalInferenceGeo,
      oauthKey: rowOauthKey,
    });
    if (rowOauthKey !== null && Math.abs(completionDelta) > EPSILON) {
      oauthDeltas.set(rowOauthKey, (oauthDeltas.get(rowOauthKey) ?? 0) + completionDelta);
    }
  }

  const oauthBuckets = [...oauthDeltas.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, completionDeltaUsd]) => ({ ...parseOAuthKey(key), completionDeltaUsd }));
  const totals = planned.reduce(
    (acc, row) => ({
      oldCompletionUsd: acc.oldCompletionUsd + (row.oldCompletionUsd ?? 0),
      newCompletionUsd: acc.newCompletionUsd + row.newCompletionUsd,
      oldTotalUsd: acc.oldTotalUsd + (row.oldTotalUsd ?? 0),
      newTotalUsd: acc.newTotalUsd + row.newTotalUsd,
    }),
    { oldCompletionUsd: 0, newCompletionUsd: 0, oldTotalUsd: 0, newTotalUsd: 0 },
  );
  const withoutHash: Omit<HistoricalCostRepriceManifest, "planSha256"> = {
    version: 1,
    mode,
    fromMs: options.fromMs,
    toMs: options.toMs,
    pricingSha256,
    eligible: planned.length,
    unchanged,
    skipped: Object.values(skippedByReason).reduce((sum, value) => sum + value, 0),
    eligibleByAlias: sortedRecord(eligibleByAlias),
    skippedByReason: sortedRecord(skippedByReason),
    skippedByAlias: sortedNestedRecord(skippedByAlias),
    assumptions: {
      standardServiceTier: standardAssumptions,
      zeroCacheCreation: zeroCacheCreationAssumptions,
      globalInferenceGeo: globalInferenceGeoAssumptions,
    },
    oauthDeltaUnmapped,
    evidenceLimitations: ["retained_payload_service_tier_replay_not_implemented"],
    totals,
    oauthBuckets,
    rows: planned,
  };
  return { ...withoutHash, planSha256: sha256(stablePlanPayload(withoutHash)) };
}

function createTargetedBackup(
  source: Database.Database,
  backupPath: string,
  manifest: HistoricalCostRepriceManifest,
): void {
  if (existsSync(backupPath)) throw new Error(`backup path already exists: ${backupPath}`);
  const backup = new Database(backupPath);
  try {
    backup.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE telemetry_backup (request_id TEXT PRIMARY KEY, row_json TEXT NOT NULL);
      CREATE TABLE oauth_usage_backup (
        provider_id TEXT NOT NULL, account TEXT NOT NULL, bucket_ms INTEGER NOT NULL,
        row_json TEXT NOT NULL, PRIMARY KEY (provider_id, account, bucket_ms)
      );
    `);
    backup
      .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      .run("manifest", JSON.stringify(manifest));
    const telemetryGet = source.prepare("SELECT * FROM telemetry WHERE request_id = ?");
    const telemetryInsert = backup.prepare(
      "INSERT INTO telemetry_backup (request_id, row_json) VALUES (?, ?)",
    );
    for (const row of manifest.rows) {
      telemetryInsert.run(row.requestId, JSON.stringify(telemetryGet.get(row.requestId)));
    }
    const oauthGet = source.prepare(
      "SELECT * FROM oauth_usage WHERE provider_id = ? AND account = ? AND bucket_ms = ?",
    );
    const oauthInsert = backup.prepare(
      "INSERT INTO oauth_usage_backup (provider_id, account, bucket_ms, row_json) VALUES (?, ?, ?, ?)",
    );
    for (const bucket of manifest.oauthBuckets) {
      oauthInsert.run(
        bucket.providerId,
        bucket.account,
        bucket.bucketMs,
        JSON.stringify(oauthGet.get(bucket.providerId, bucket.account, bucket.bucketMs)),
      );
    }
    const check = backup.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`targeted backup quick_check failed: ${String(check)}`);
  } finally {
    backup.close();
  }
}

export function applyHistoricalCostReprice(
  db: Database.Database,
  catalog: ReadonlyMap<string, CatalogEntry>,
  pricingSha256: string,
  options: HistoricalCostRepriceOptions & {
    expectedPlanSha256: string;
    backupPath: string;
  },
): HistoricalCostRepriceManifest {
  const initialPlan = planHistoricalCostReprice(db, catalog, pricingSha256, options);
  if (initialPlan.planSha256 !== options.expectedPlanSha256) {
    throw new Error(
      `plan hash mismatch: expected ${options.expectedPlanSha256}, got ${initialPlan.planSha256}`,
    );
  }
  createTargetedBackup(db, options.backupPath, initialPlan);
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = planHistoricalCostReprice(db, catalog, pricingSha256, options);
    if (plan.planSha256 !== options.expectedPlanSha256) {
      throw new Error(
        `plan changed after backup: expected ${options.expectedPlanSha256}, got ${plan.planSha256}`,
      );
    }
    const updateTelemetry = db.prepare(
      "UPDATE telemetry SET decision_json = ?, cost_usd = ? WHERE request_id = ?",
    );
    const readDecision = db.prepare("SELECT decision_json FROM telemetry WHERE request_id = ?");
    for (const row of plan.rows) {
      const stored = readDecision.get(row.requestId) as { decision_json: string } | undefined;
      if (stored === undefined) throw new Error(`telemetry row disappeared: ${row.requestId}`);
      const decision = JSON.parse(stored.decision_json) as ParsedDecision;
      const attempts = Array.isArray(decision.provider_attempts)
        ? (decision.provider_attempts as DecisionAttempt[])
        : [];
      const attempt = attempts[row.attemptIndex];
      if (attempt === undefined || attempt.status !== "ok" || attempt.alias !== row.alias) {
        throw new Error(`served attempt changed: ${row.requestId}`);
      }
      attempt.cost_usd = row.newCompletionUsd;
      const breakdown = object(decision.cost_breakdown) ?? {};
      breakdown.completion_usd = row.newCompletionUsd;
      breakdown.total_usd = row.newTotalUsd;
      decision.cost_breakdown = breakdown;
      const result = updateTelemetry.run(JSON.stringify(decision), row.newTotalUsd, row.requestId);
      if (result.changes !== 1) throw new Error(`telemetry update failed: ${row.requestId}`);
    }
    const updateOauth = db.prepare(
      `UPDATE oauth_usage
          SET cost_usd = COALESCE(cost_usd, 0) + ?
        WHERE provider_id = ? AND account = ? AND bucket_ms = ?`,
    );
    for (const bucket of plan.oauthBuckets) {
      const result = updateOauth.run(
        bucket.completionDeltaUsd,
        bucket.providerId,
        bucket.account,
        bucket.bucketMs,
      );
      if (result.changes !== 1) {
        throw new Error(
          `oauth bucket update failed: ${bucket.providerId}/${bucket.account}/${bucket.bucketMs}`,
        );
      }
    }
    db.exec("COMMIT");
    return plan;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface CurrentTelemetryRow {
  decision_json: string;
  cost_usd: number | null;
  created_at: number;
}

type PlannedRowState = "old" | "new";

function sameCost(actual: number | null, expected: number | null): boolean {
  return (
    actual === expected ||
    (actual !== null && expected !== null && Math.abs(actual - expected) <= EPSILON)
  );
}

function validateManifest(manifest: HistoricalCostRepriceManifest): void {
  if (manifest.version !== 1) throw new Error(`unsupported manifest version: ${manifest.version}`);
  if (manifest.eligible !== manifest.rows.length) {
    throw new Error("manifest eligible count does not match rows");
  }
  const { planSha256, ...withoutHash } = manifest;
  const actualSha256 = sha256(stablePlanPayload(withoutHash));
  if (actualSha256 !== planSha256) {
    throw new Error(`manifest hash mismatch: expected ${planSha256}, got ${actualSha256}`);
  }
  const requestIds = new Set<string>();
  for (const row of manifest.rows) {
    if (requestIds.has(row.requestId)) {
      throw new Error(`manifest contains duplicate request id: ${row.requestId}`);
    }
    requestIds.add(row.requestId);
  }
}

function plannedRowState(current: CurrentTelemetryRow, row: PlannedRow): PlannedRowState {
  if (current.created_at !== row.createdAt) {
    throw new Error(`telemetry timestamp changed: ${row.requestId}`);
  }
  let decision: ParsedDecision;
  try {
    decision = JSON.parse(current.decision_json) as ParsedDecision;
  } catch {
    throw new Error(`telemetry decision is no longer valid JSON: ${row.requestId}`);
  }
  const attempts = Array.isArray(decision.provider_attempts)
    ? (decision.provider_attempts as DecisionAttempt[])
    : [];
  const attempt = attempts[row.attemptIndex];
  if (attempt === undefined || attempt.status !== "ok" || attempt.alias !== row.alias) {
    throw new Error(`served attempt changed: ${row.requestId}`);
  }
  const attemptCost = finite(attempt.cost_usd);
  const breakdown = object(decision.cost_breakdown);
  const breakdownCompletion = finite(breakdown?.completion_usd);
  const breakdownTotal = finite(breakdown?.total_usd);
  const matchesNew =
    sameCost(current.cost_usd, row.newTotalUsd) &&
    sameCost(attemptCost, row.newCompletionUsd) &&
    sameCost(breakdownCompletion, row.newCompletionUsd) &&
    sameCost(breakdownTotal, row.newTotalUsd);
  if (matchesNew) return "new";

  const matchesOld =
    sameCost(current.cost_usd, row.oldTotalUsd) &&
    sameCost(attemptCost, row.oldCompletionUsd) &&
    (breakdownCompletion === null || sameCost(breakdownCompletion, row.oldCompletionUsd)) &&
    (breakdownTotal === null || sameCost(breakdownTotal, row.oldTotalUsd));
  const matchesLegacyCompletionOnlyTotal =
    row.oldCompletionUsd !== null &&
    row.oldTotalUsd !== null &&
    !sameCost(row.oldCompletionUsd, row.oldTotalUsd) &&
    sameCost(current.cost_usd, row.oldCompletionUsd) &&
    sameCost(attemptCost, row.oldCompletionUsd) &&
    sameCost(breakdownCompletion, row.oldCompletionUsd) &&
    sameCost(breakdownTotal, row.oldTotalUsd);
  if (matchesOld || matchesLegacyCompletionOnlyTotal) return "old";
  throw new Error(`old values no longer match manifest: ${row.requestId}`);
}

function batchOAuthDeltas(rows: readonly PlannedRow[]): Array<{
  providerId: string;
  account: string;
  bucketMs: number;
  completionDeltaUsd: number;
}> {
  const deltas = new Map<string, number>();
  for (const row of rows) {
    if (row.oauthKey === null) continue;
    const delta = row.newCompletionUsd - (row.oldCompletionUsd ?? 0);
    if (Math.abs(delta) <= EPSILON) continue;
    deltas.set(row.oauthKey, (deltas.get(row.oauthKey) ?? 0) + delta);
  }
  return [...deltas.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, completionDeltaUsd]) => ({ ...parseOAuthKey(key), completionDeltaUsd }));
}

function quickCheckBackup(path: string): void {
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const check = backup.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`targeted backup quick_check failed: ${String(check)}`);
  } finally {
    backup.close();
  }
}

function createBatchTargetedBackup(
  source: Database.Database,
  backupDir: string,
  manifest: HistoricalCostRepriceManifest,
  startRowIndex: number,
  endRowIndex: number,
  rows: readonly PlannedRow[],
  oauthBuckets: ReturnType<typeof batchOAuthDeltas>,
): string {
  mkdirSync(backupDir, { recursive: true });
  const identity = sha256(rows.map((row) => row.requestId).join("\n")).slice(0, 12);
  const name = `batch-${String(startRowIndex).padStart(9, "0")}-${String(endRowIndex).padStart(9, "0")}-${identity}.sqlite`;
  const backupPath = join(backupDir, name);
  if (existsSync(backupPath)) {
    quickCheckBackup(backupPath);
    const existing = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const metadata = Object.fromEntries(
        (
          existing.prepare("SELECT key, value FROM metadata").all() as Array<{
            key: string;
            value: string;
          }>
        ).map(({ key, value }) => [key, value]),
      );
      if (
        metadata.plan_sha256 !== manifest.planSha256 ||
        metadata.request_ids_sha256 !== sha256(rows.map((row) => row.requestId).join("\n"))
      ) {
        throw new Error(`existing targeted backup does not match batch: ${backupPath}`);
      }
    } finally {
      existing.close();
    }
    return backupPath;
  }

  const temporaryPath = `${backupPath}.tmp-${process.pid}`;
  rmSync(temporaryPath, { force: true });
  const backup = new Database(temporaryPath);
  try {
    backup.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE telemetry_backup (request_id TEXT PRIMARY KEY, row_json TEXT NOT NULL);
      CREATE TABLE oauth_usage_backup (
        provider_id TEXT NOT NULL, account TEXT NOT NULL, bucket_ms INTEGER NOT NULL,
        row_json TEXT NOT NULL, PRIMARY KEY (provider_id, account, bucket_ms)
      );
    `);
    const metadataInsert = backup.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    metadataInsert.run("plan_sha256", manifest.planSha256);
    metadataInsert.run("pricing_sha256", manifest.pricingSha256);
    metadataInsert.run("start_row_index", String(startRowIndex));
    metadataInsert.run("end_row_index", String(endRowIndex));
    metadataInsert.run("request_ids_sha256", sha256(rows.map((row) => row.requestId).join("\n")));
    metadataInsert.run("rows", JSON.stringify(rows));
    metadataInsert.run("oauth_deltas", JSON.stringify(oauthBuckets));
    const telemetryGet = source.prepare("SELECT * FROM telemetry WHERE request_id = ?");
    const telemetryInsert = backup.prepare(
      "INSERT INTO telemetry_backup (request_id, row_json) VALUES (?, ?)",
    );
    for (const row of rows) {
      const stored = telemetryGet.get(row.requestId);
      if (stored === undefined) throw new Error(`telemetry row disappeared: ${row.requestId}`);
      telemetryInsert.run(row.requestId, JSON.stringify(stored));
    }
    const oauthGet = source.prepare(
      "SELECT * FROM oauth_usage WHERE provider_id = ? AND account = ? AND bucket_ms = ?",
    );
    const oauthInsert = backup.prepare(
      "INSERT INTO oauth_usage_backup (provider_id, account, bucket_ms, row_json) VALUES (?, ?, ?, ?)",
    );
    for (const bucket of oauthBuckets) {
      const stored = oauthGet.get(bucket.providerId, bucket.account, bucket.bucketMs);
      if (stored === undefined) {
        throw new Error(
          `oauth bucket disappeared: ${bucket.providerId}/${bucket.account}/${bucket.bucketMs}`,
        );
      }
      oauthInsert.run(bucket.providerId, bucket.account, bucket.bucketMs, JSON.stringify(stored));
    }
    const check = backup.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`targeted backup quick_check failed: ${String(check)}`);
  } catch (error) {
    backup.close();
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  backup.close();
  renameSync(temporaryPath, backupPath);
  return backupPath;
}

function readCheckpoint(
  path: string,
  manifest: HistoricalCostRepriceManifest,
): HistoricalCostRepriceCheckpoint {
  if (!existsSync(path)) {
    return {
      version: 1,
      planSha256: manifest.planSha256,
      pricingSha256: manifest.pricingSha256,
      totalRows: manifest.rows.length,
      nextRowIndex: 0,
      appliedRows: 0,
      alreadyAppliedRows: 0,
      batchesApplied: 0,
      completed: manifest.rows.length === 0,
      lastBatch: null,
    };
  }
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as HistoricalCostRepriceCheckpoint;
  if (
    checkpoint.version !== 1 ||
    checkpoint.planSha256 !== manifest.planSha256 ||
    checkpoint.pricingSha256 !== manifest.pricingSha256 ||
    checkpoint.totalRows !== manifest.rows.length ||
    !Number.isSafeInteger(checkpoint.nextRowIndex) ||
    checkpoint.nextRowIndex < 0 ||
    checkpoint.nextRowIndex > manifest.rows.length
  ) {
    throw new Error("checkpoint does not match manifest");
  }
  return checkpoint;
}

function writeCheckpoint(path: string, checkpoint: HistoricalCostRepriceCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: "w" });
  renameSync(temporaryPath, path);
}

function positiveInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a nonnegative" : "a positive"} integer`);
  }
  return value;
}

function assertResourceLimits(options: HistoricalCostManifestApplyOptions): void {
  options.healthCheck?.();
  if (options.databasePath === undefined) return;
  const maxWalBytes = options.maxWalBytes ?? DEFAULT_MAX_WAL_BYTES;
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  positiveInteger(maxWalBytes, "maxWalBytes");
  positiveInteger(minFreeBytes, "minFreeBytes");
  const walPath = `${options.databasePath}-wal`;
  const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
  if (walBytes > maxWalBytes) {
    throw new Error(`WAL safety limit exceeded: ${walBytes} > ${maxWalBytes}`);
  }
  const fs = statfsSync(dirname(options.databasePath), { bigint: true });
  const freeBytes = fs.bavail * fs.bsize;
  if (freeBytes < BigInt(minFreeBytes)) {
    throw new Error(`free disk safety limit breached: ${freeBytes} < ${minFreeBytes}`);
  }
}

function sleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function verifyHistoricalCostRepriceManifest(
  db: Database.Database,
  manifest: HistoricalCostRepriceManifest,
  options: { startRowIndex?: number; endRowIndex?: number } = {},
): HistoricalCostRepriceVerification {
  validateManifest(manifest);
  const startRowIndex = positiveInteger(options.startRowIndex ?? 0, "startRowIndex", true);
  const endRowIndex = positiveInteger(
    options.endRowIndex ?? manifest.rows.length,
    "endRowIndex",
    true,
  );
  if (endRowIndex < startRowIndex || endRowIndex > manifest.rows.length) {
    throw new Error(
      `invalid verification range: ${startRowIndex}..${endRowIndex} of ${manifest.rows.length}`,
    );
  }

  const readTelemetry = db.prepare(
    "SELECT decision_json, cost_usd, created_at FROM telemetry WHERE request_id = ?",
  );
  let totalUsd = 0;
  for (let index = startRowIndex; index < endRowIndex; index += 1) {
    const row = manifest.rows[index];
    if (row === undefined) throw new Error(`manifest row disappeared at index ${index}`);
    const current = readTelemetry.get(row.requestId) as CurrentTelemetryRow | undefined;
    if (current === undefined) throw new Error(`telemetry row disappeared: ${row.requestId}`);
    if (plannedRowState(current, row) !== "new") {
      throw new Error(`manifest row is not applied: ${row.requestId}`);
    }
    totalUsd += current.cost_usd ?? 0;
  }
  return { verifiedRows: endRowIndex - startRowIndex, totalUsd };
}

export function applyHistoricalCostRepriceManifest(
  db: Database.Database,
  manifest: HistoricalCostRepriceManifest,
  options: HistoricalCostManifestApplyOptions,
): HistoricalCostRepriceCheckpoint {
  validateManifest(manifest);
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const maxBatches = positiveInteger(options.maxBatches ?? DEFAULT_MAX_BATCHES, "maxBatches");
  const batchDelayMs = positiveInteger(
    options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS,
    "batchDelayMs",
    true,
  );
  let checkpoint = readCheckpoint(options.checkpointPath, manifest);
  if (checkpoint.completed) return checkpoint;

  const readTelemetry = db.prepare(
    "SELECT decision_json, cost_usd, created_at FROM telemetry WHERE request_id = ?",
  );
  const updateTelemetry = db.prepare(
    "UPDATE telemetry SET decision_json = ?, cost_usd = ? WHERE request_id = ?",
  );
  const updateOauth = db.prepare(
    `UPDATE oauth_usage
        SET cost_usd = COALESCE(cost_usd, 0) + ?
      WHERE provider_id = ? AND account = ? AND bucket_ms = ?`,
  );

  for (let batch = 0; batch < maxBatches && !checkpoint.completed; batch += 1) {
    assertResourceLimits(options);
    const startRowIndex = checkpoint.nextRowIndex;
    const endRowIndex = Math.min(startRowIndex + batchSize, manifest.rows.length);
    const rows = manifest.rows.slice(startRowIndex, endRowIndex);
    const states = rows.map((row) => {
      const current = readTelemetry.get(row.requestId) as CurrentTelemetryRow | undefined;
      if (current === undefined) throw new Error(`telemetry row disappeared: ${row.requestId}`);
      return plannedRowState(current, row);
    });
    const pendingRows = rows.filter((_, index) => states[index] === "old");
    const alreadyAppliedRows = rows.length - pendingRows.length;
    const oauthBuckets = batchOAuthDeltas(pendingRows);
    const backupPath =
      pendingRows.length === 0
        ? null
        : createBatchTargetedBackup(
            db,
            options.backupDir,
            manifest,
            startRowIndex,
            endRowIndex,
            pendingRows,
            oauthBuckets,
          );

    if (pendingRows.length > 0) {
      assertResourceLimits(options);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const current = readTelemetry.get(row.requestId) as CurrentTelemetryRow | undefined;
          if (current === undefined) throw new Error(`telemetry row disappeared: ${row.requestId}`);
          const expectedState = pendingRows.includes(row) ? "old" : "new";
          if (plannedRowState(current, row) !== expectedState) {
            throw new Error(`batch changed after targeted backup: ${row.requestId}`);
          }
        }
        for (const row of pendingRows) {
          const current = readTelemetry.get(row.requestId) as CurrentTelemetryRow;
          const decision = JSON.parse(current.decision_json) as ParsedDecision;
          const attempts = decision.provider_attempts as DecisionAttempt[];
          const attempt = attempts[row.attemptIndex] as DecisionAttempt;
          attempt.cost_usd = row.newCompletionUsd;
          const breakdown = object(decision.cost_breakdown) ?? {};
          breakdown.completion_usd = row.newCompletionUsd;
          breakdown.total_usd = row.newTotalUsd;
          decision.cost_breakdown = breakdown;
          const result = updateTelemetry.run(
            JSON.stringify(decision),
            row.newTotalUsd,
            row.requestId,
          );
          if (result.changes !== 1) throw new Error(`telemetry update failed: ${row.requestId}`);
        }
        for (const bucket of oauthBuckets) {
          const result = updateOauth.run(
            bucket.completionDeltaUsd,
            bucket.providerId,
            bucket.account,
            bucket.bucketMs,
          );
          if (result.changes !== 1) {
            throw new Error(
              `oauth bucket update failed: ${bucket.providerId}/${bucket.account}/${bucket.bucketMs}`,
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    checkpoint = {
      ...checkpoint,
      nextRowIndex: endRowIndex,
      appliedRows: checkpoint.appliedRows + pendingRows.length,
      alreadyAppliedRows: checkpoint.alreadyAppliedRows + alreadyAppliedRows,
      batchesApplied: checkpoint.batchesApplied + 1,
      completed: endRowIndex === manifest.rows.length,
      lastBatch: {
        startRowIndex,
        endRowIndex,
        mutatedRows: pendingRows.length,
        alreadyAppliedRows,
        oauthBucketsUpdated: oauthBuckets.length,
        backupPath,
      },
    };
    writeCheckpoint(options.checkpointPath, checkpoint);
    if (!checkpoint.completed && batch + 1 < maxBatches) sleep(batchDelayMs);
  }
  return checkpoint;
}

interface CliArgs {
  db: string;
  pricing: string;
  fromMs?: number;
  toMs?: number;
  mode: HistoricalCostRepriceMode;
  applyManifest?: string;
  verifyManifest?: string;
  expectedPlanSha256?: string;
  startRowIndex?: number;
  endRowIndex?: number;
  manifest?: string;
  checkpoint?: string;
  backupDir?: string;
  batchSize: number;
  maxBatches: number;
  batchDelayMs: number;
  maxWalBytes: number;
  minFreeBytes: number;
  healthUrl?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueArguments = new Set([
    "--db",
    "--pricing",
    "--from-ms",
    "--to-ms",
    "--mode",
    "--apply-manifest",
    "--verify-manifest",
    "--expected-plan-sha256",
    "--start-row-index",
    "--end-row-index",
    "--manifest",
    "--checkpoint",
    "--backup-dir",
    "--batch-size",
    "--max-batches",
    "--batch-delay-ms",
    "--max-wal-bytes",
    "--min-free-bytes",
    "--health-url",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply" || arg === "--dry-run" || arg === "--skip-health-check") {
      flags.add(arg);
      continue;
    }
    if (!arg?.startsWith("--")) throw new Error(`unexpected argument: ${arg ?? ""}`);
    if (!valueArguments.has(arg)) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`missing required ${name}`);
    return value;
  };
  const mode = values.get("--mode") ?? "exact";
  if (mode !== "exact" && mode !== "best-evidence") throw new Error("invalid --mode");
  if (flags.has("--apply") && flags.has("--dry-run")) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  if (flags.has("--apply")) {
    throw new Error("one-shot --apply is disabled; use --apply-manifest with bounded batches");
  }
  const applyManifest = values.get("--apply-manifest");
  const verifyManifest = values.get("--verify-manifest");
  if (applyManifest !== undefined && verifyManifest !== undefined) {
    throw new Error("--apply-manifest and --verify-manifest are mutually exclusive");
  }
  if (applyManifest !== undefined && (flags.has("--apply") || flags.has("--dry-run"))) {
    throw new Error("--apply-manifest cannot be combined with --apply or --dry-run");
  }
  if (verifyManifest !== undefined && (flags.has("--apply") || flags.has("--dry-run"))) {
    throw new Error("--verify-manifest cannot be combined with --apply or --dry-run");
  }
  if (
    applyManifest !== undefined &&
    values.get("--health-url") === undefined &&
    !flags.has("--skip-health-check")
  ) {
    throw new Error("--apply-manifest requires --health-url or explicit --skip-health-check");
  }
  if (applyManifest !== undefined && values.get("--expected-plan-sha256") === undefined) {
    throw new Error("--apply-manifest requires --expected-plan-sha256");
  }
  if (verifyManifest !== undefined && values.get("--expected-plan-sha256") === undefined) {
    throw new Error("--verify-manifest requires --expected-plan-sha256");
  }
  const fromMs = values.get("--from-ms");
  const toMs = values.get("--to-ms");
  if (
    applyManifest === undefined &&
    verifyManifest === undefined &&
    (fromMs === undefined || toMs === undefined)
  ) {
    throw new Error("dry-run and one-shot apply require --from-ms and --to-ms");
  }
  return {
    db: resolve(required("--db")),
    pricing: resolve(required("--pricing")),
    ...(fromMs !== undefined ? { fromMs: Number(fromMs) } : {}),
    ...(toMs !== undefined ? { toMs: Number(toMs) } : {}),
    mode,
    ...(applyManifest !== undefined ? { applyManifest: resolve(applyManifest) } : {}),
    ...(verifyManifest !== undefined ? { verifyManifest: resolve(verifyManifest) } : {}),
    ...(values.get("--expected-plan-sha256") !== undefined
      ? { expectedPlanSha256: values.get("--expected-plan-sha256") }
      : {}),
    ...(values.get("--start-row-index") !== undefined
      ? { startRowIndex: Number(values.get("--start-row-index")) }
      : {}),
    ...(values.get("--end-row-index") !== undefined
      ? { endRowIndex: Number(values.get("--end-row-index")) }
      : {}),
    ...(values.get("--manifest") !== undefined
      ? { manifest: resolve(values.get("--manifest") ?? "") }
      : {}),
    ...(values.get("--checkpoint") !== undefined
      ? { checkpoint: resolve(values.get("--checkpoint") ?? "") }
      : {}),
    ...(values.get("--backup-dir") !== undefined
      ? { backupDir: resolve(values.get("--backup-dir") ?? "") }
      : {}),
    batchSize: Number(values.get("--batch-size") ?? DEFAULT_BATCH_SIZE),
    maxBatches: Number(values.get("--max-batches") ?? DEFAULT_MAX_BATCHES),
    batchDelayMs: Number(values.get("--batch-delay-ms") ?? DEFAULT_BATCH_DELAY_MS),
    maxWalBytes: Number(values.get("--max-wal-bytes") ?? DEFAULT_MAX_WAL_BYTES),
    minFreeBytes: Number(values.get("--min-free-bytes") ?? DEFAULT_MIN_FREE_BYTES),
    ...(values.get("--health-url") !== undefined ? { healthUrl: values.get("--health-url") } : {}),
  };
}

function cli(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const pricingText = readFileSync(args.pricing, "utf8");
  const pricingSha256 = sha256(pricingText);
  const gradual = args.applyManifest !== undefined;
  const db = new Database(args.db, { readonly: !gradual, fileMustExist: true });
  try {
    if (args.applyManifest !== undefined) {
      if (args.manifest !== undefined) {
        throw new Error("--manifest is only an output path for dry-run planning");
      }
      const manifest = JSON.parse(
        readFileSync(args.applyManifest, "utf8"),
      ) as HistoricalCostRepriceManifest;
      validateManifest(manifest);
      if (manifest.planSha256 !== args.expectedPlanSha256) {
        throw new Error(
          `plan hash mismatch: expected ${args.expectedPlanSha256 ?? ""}, got ${manifest.planSha256}`,
        );
      }
      if (manifest.pricingSha256 !== pricingSha256) {
        throw new Error(
          `pricing hash mismatch: manifest ${manifest.pricingSha256}, current ${pricingSha256}`,
        );
      }
      const healthCheck =
        args.healthUrl === undefined
          ? undefined
          : (): void => {
              execFileSync(
                process.execPath,
                [
                  "--input-type=module",
                  "--eval",
                  `const response = await fetch(process.env.HELM_REPRICE_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error(\`health endpoint returned \${response.status}\`);`,
                ],
                {
                  env: { ...process.env, HELM_REPRICE_HEALTH_URL: args.healthUrl ?? "" },
                  stdio: "ignore",
                },
              );
            };
      const checkpoint = applyHistoricalCostRepriceManifest(db, manifest, {
        checkpointPath: args.checkpoint ?? `${args.applyManifest}.progress.json`,
        backupDir: args.backupDir ?? `${args.applyManifest}.backups`,
        batchSize: args.batchSize,
        maxBatches: args.maxBatches,
        batchDelayMs: args.batchDelayMs,
        databasePath: args.db,
        maxWalBytes: args.maxWalBytes,
        minFreeBytes: args.minFreeBytes,
        ...(healthCheck !== undefined ? { healthCheck } : {}),
      });
      process.stdout.write(`${JSON.stringify(checkpoint, null, 2)}\n`);
      return;
    }

    if (args.verifyManifest !== undefined) {
      if (args.manifest !== undefined) {
        throw new Error("--manifest is only an output path for dry-run planning");
      }
      const manifest = JSON.parse(
        readFileSync(args.verifyManifest, "utf8"),
      ) as HistoricalCostRepriceManifest;
      validateManifest(manifest);
      if (manifest.planSha256 !== args.expectedPlanSha256) {
        throw new Error(
          `plan hash mismatch: expected ${args.expectedPlanSha256 ?? ""}, got ${manifest.planSha256}`,
        );
      }
      if (manifest.pricingSha256 !== pricingSha256) {
        throw new Error(
          `pricing hash mismatch: manifest ${manifest.pricingSha256}, current ${pricingSha256}`,
        );
      }
      const verification = verifyHistoricalCostRepriceManifest(db, manifest, {
        ...(args.startRowIndex !== undefined ? { startRowIndex: args.startRowIndex } : {}),
        ...(args.endRowIndex !== undefined ? { endRowIndex: args.endRowIndex } : {}),
      });
      process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
      return;
    }

    const catalog = loadRuntimeCatalog({ configDir: dirname(args.pricing) });
    const options = {
      fromMs:
        args.fromMs ??
        (() => {
          throw new Error("missing --from-ms");
        })(),
      toMs:
        args.toMs ??
        (() => {
          throw new Error("missing --to-ms");
        })(),
      mode: args.mode,
    };
    const manifest = planHistoricalCostReprice(db, catalog, pricingSha256, options);
    const output = `${JSON.stringify(manifest, null, 2)}\n`;
    if (args.manifest !== undefined) {
      writeFileSync(args.manifest, output, { flag: "wx" });
      process.stdout.write(
        `${JSON.stringify(
          {
            manifestPath: args.manifest,
            planSha256: manifest.planSha256,
            pricingSha256: manifest.pricingSha256,
            mode: manifest.mode,
            eligible: manifest.eligible,
            unchanged: manifest.unchanged,
            skipped: manifest.skipped,
            assumptions: manifest.assumptions,
            oauthDeltaUnmapped: manifest.oauthDeltaUnmapped,
            totals: manifest.totals,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(output);
    }
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli();
