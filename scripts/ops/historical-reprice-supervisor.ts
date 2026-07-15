import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface SupervisorSample {
  capturedAt: string;
  load1: number;
  memAvailableBytes: number;
  helmCpuPercent: number;
  helmMemoryPercent: number;
  healthStatus: number;
  healthLatencyMs: number;
  walBytes: number;
  diskFreeBytes: number;
  restarts: number;
  oomKilled: boolean;
  fiveXx: number;
  timeouts: number;
  sqliteBusy: number;
}

export interface SupervisorThresholds {
  preflightLoad1: number;
  preflightMemBytes: number;
  preflightCpuPercent: number;
  preflightHelmMemoryPercent: number;
  preflightHealthMs: number;
  preflightWalBytes: number;
  preflightDiskBytes: number;
  stopLoad1: number;
  stopMemBytes: number;
  stopCpuPercent: number;
  stopHelmMemoryPercent: number;
  stopHealthMs: number;
  stopWalBytes: number;
  stopDiskBytes: number;
}

export const DEFAULT_SUPERVISOR_THRESHOLDS: SupervisorThresholds = {
  preflightLoad1: 1.2,
  preflightMemBytes: 768 * MIB,
  preflightCpuPercent: 50,
  preflightHelmMemoryPercent: 55,
  preflightHealthMs: 300,
  preflightWalBytes: 384 * MIB,
  preflightDiskBytes: 14 * GIB,
  stopLoad1: 1.5,
  stopMemBytes: 640 * MIB,
  stopCpuPercent: 60,
  stopHelmMemoryPercent: 60,
  stopHealthMs: 500,
  stopWalBytes: 512 * MIB,
  stopDiskBytes: 12 * GIB,
};

export interface RuntimeSafetyState {
  highCpuSamples: number;
  slowHealthSamples: number;
  baselineRestarts: number;
}

export interface HistoricalWindow {
  name: string;
  fromMs: number;
  toMs: number;
}

interface ManifestRow {
  oldTotalUsd: number | null;
  newTotalUsd: number;
}

interface RepriceManifest {
  version: 1;
  mode: "best-evidence" | "exact";
  fromMs: number;
  toMs: number;
  pricingSha256: string;
  eligible: number;
  unchanged: number;
  skipped: number;
  totals: {
    oldTotalUsd: number;
    newTotalUsd: number;
  };
  rows: ManifestRow[];
  planSha256: string;
}

interface RepriceCheckpoint {
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

interface SupervisorConfig {
  container: string;
  hostDatabasePath: string;
  containerDatabasePath: string;
  containerPricingPath: string;
  hostStateDir: string;
  containerStateDir: string;
  statusPath: string;
  startMs: number;
  cutoffMs: number;
  sampleIntervalMs: number;
  unsafePollMs: number;
  batchDelayMs: number;
  cooldownMs: number;
  maxStageBatches: number;
  thresholds: SupervisorThresholds;
}

interface SupervisorStatus {
  version: 1;
  phase: "starting" | "waiting_safety" | "planning" | "applying" | "cooling" | "complete";
  updatedAt: string;
  startedAt: string;
  activeWindow: string | null;
  checkpoint: { nextRowIndex: number; totalRows: number; completed: boolean } | null;
  stageBatches: number;
  completedWindows: number;
  totalWindows: number;
  sample: SupervisorSample | null;
  reasons: string[];
  lastError: string | null;
  totals: {
    appliedOldUsd: number;
    appliedNewUsd: number;
    appliedDeltaUsd: number;
  } | null;
  backupAggregateSha256: string | null;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function percent(value: string, name: string): number {
  const parsed = Number(value.trim().replace(/%$/, ""));
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}: ${value}`);
  return parsed;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${name}: ${raw}`);
  return parsed;
}

function parseTimestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}: ${value}`);
  return parsed;
}

export function buildUtcWindows(startMs: number, cutoffMs: number): HistoricalWindow[] {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(cutoffMs) || cutoffMs <= startMs) {
    throw new Error(`invalid historical window range: ${startMs}..${cutoffMs}`);
  }
  const windows: HistoricalWindow[] = [];
  for (let fromMs = startMs; fromMs < cutoffMs; fromMs += DAY_MS) {
    const midnight = new Date(fromMs);
    if (
      midnight.getUTCHours() !== 0 ||
      midnight.getUTCMinutes() !== 0 ||
      midnight.getUTCSeconds() !== 0 ||
      midnight.getUTCMilliseconds() !== 0
    ) {
      throw new Error("historical window start must be UTC midnight");
    }
    windows.push({
      name: midnight.toISOString().slice(0, 10),
      fromMs,
      toMs: Math.min(fromMs + DAY_MS, cutoffMs),
    });
  }
  return windows;
}

export function evaluatePreflight(
  samples: readonly SupervisorSample[],
  thresholds = DEFAULT_SUPERVISOR_THRESHOLDS,
): { safe: boolean; reasons: string[] } {
  if (samples.length !== 3) {
    return { safe: false, reasons: [`need 3 preflight samples, got ${samples.length}`] };
  }
  const reasons: string[] = [];
  const baselineRestarts = samples[0]?.restarts ?? 0;
  for (const [index, sample] of samples.entries()) {
    const prefix = `sample ${index + 1}: `;
    if (sample.load1 >= thresholds.preflightLoad1) {
      reasons.push(`${prefix}load1 at or above ${thresholds.preflightLoad1}`);
    }
    if (sample.memAvailableBytes < thresholds.preflightMemBytes) {
      reasons.push(`${prefix}available memory below 768 MiB`);
    }
    if (sample.helmCpuPercent >= thresholds.preflightCpuPercent) {
      reasons.push(`${prefix}Helm CPU at or above 50%`);
    }
    if (sample.helmMemoryPercent >= thresholds.preflightHelmMemoryPercent) {
      reasons.push(`${prefix}Helm memory at or above 55%`);
    }
    if (sample.healthStatus !== 200 || sample.healthLatencyMs >= thresholds.preflightHealthMs) {
      reasons.push(`${prefix}health is not 200 below 300 ms`);
    }
    if (sample.walBytes >= thresholds.preflightWalBytes) {
      reasons.push(`${prefix}WAL at or above 384 MiB`);
    }
    if (sample.diskFreeBytes <= thresholds.preflightDiskBytes) {
      reasons.push(`${prefix}disk free at or below 14 GiB`);
    }
    if (sample.restarts !== baselineRestarts) reasons.push(`${prefix}restart count changed`);
    if (sample.oomKilled) reasons.push(`${prefix}OOM flag is set`);
    if (sample.fiveXx > 0) reasons.push(`${prefix}new 5xx detected`);
    if (sample.timeouts > 0) reasons.push(`${prefix}new timeout detected`);
    if (sample.sqliteBusy > 0) reasons.push(`${prefix}new SQLITE_BUSY detected`);
  }
  return { safe: reasons.length === 0, reasons };
}

export function shouldRunPreflight(stageBatches: number, recoveryRequired: boolean): boolean {
  return stageBatches === 0 || recoveryRequired;
}

export function evaluateRuntimeSafety(
  sample: SupervisorSample,
  previous: RuntimeSafetyState,
  thresholds = DEFAULT_SUPERVISOR_THRESHOLDS,
): { stop: boolean; reasons: string[]; state: RuntimeSafetyState } {
  const state = {
    highCpuSamples:
      sample.helmCpuPercent >= thresholds.stopCpuPercent ? previous.highCpuSamples + 1 : 0,
    slowHealthSamples:
      sample.healthLatencyMs > thresholds.stopHealthMs ? previous.slowHealthSamples + 1 : 0,
    baselineRestarts: previous.baselineRestarts,
  };
  const reasons: string[] = [];
  if (sample.load1 >= thresholds.stopLoad1) reasons.push("load1 at or above 1.5");
  if (sample.memAvailableBytes < thresholds.stopMemBytes) {
    reasons.push("available memory below 640 MiB");
  }
  if (sample.helmMemoryPercent >= thresholds.stopHelmMemoryPercent) {
    reasons.push("Helm memory at or above 60%");
  }
  if (state.highCpuSamples >= 2) reasons.push("Helm CPU sustained at or above 60%");
  if (sample.healthStatus !== 200) reasons.push("health returned non-200");
  if (state.slowHealthSamples >= 2) {
    reasons.push("health latency consecutively above 500 ms");
  }
  if (sample.walBytes >= thresholds.stopWalBytes) reasons.push("WAL at or above 512 MiB");
  if (sample.diskFreeBytes < thresholds.stopDiskBytes) reasons.push("disk free below 12 GiB");
  if (sample.restarts !== previous.baselineRestarts) reasons.push("restart count changed");
  if (sample.oomKilled) reasons.push("OOM flag is set");
  if (sample.fiveXx > 0) reasons.push("new 5xx detected");
  if (sample.timeouts > 0) reasons.push("new timeout detected");
  if (sample.sqliteBusy > 0) reasons.push("new SQLITE_BUSY detected");
  return { stop: reasons.length > 0, reasons, state };
}

export function parseStructuredLogSignals(text: string): {
  fiveXx: number;
  timeouts: number;
  sqliteBusy: number;
} {
  let fiveXx = 0;
  let timeouts = 0;
  let sqliteBusy = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const body = record(parsed);
    if (body === null) continue;
    const rawStatus = body.status ?? body.http_status ?? body.status_code;
    const status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
    if (Number.isFinite(status) && status >= 500 && status < 600) fiveXx += 1;
    const selectedText = [body.message, body.error_class, body.error]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (/timeout|timed out/.test(selectedText)) timeouts += 1;
    if (/sqlite_busy|database is locked/.test(selectedText)) sqliteBusy += 1;
  }
  return { fiveXx, timeouts, sqliteBusy };
}

function runCommand(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: options.maxBuffer ?? 32 * MIB,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`, {
              cause: error,
            }),
          );
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
  renameSync(temporaryPath, path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseManifest(path: string, window: HistoricalWindow): RepriceManifest {
  const body = record(readJson(path));
  if (body === null || body.version !== 1 || !Array.isArray(body.rows)) {
    throw new Error(`invalid reprice manifest: ${path}`);
  }
  const manifest = body as unknown as RepriceManifest;
  if (
    manifest.fromMs !== window.fromMs ||
    manifest.toMs !== window.toMs ||
    manifest.mode !== "best-evidence" ||
    manifest.eligible !== manifest.rows.length ||
    typeof manifest.planSha256 !== "string" ||
    typeof manifest.pricingSha256 !== "string"
  ) {
    throw new Error(`manifest metadata does not match ${window.name}`);
  }
  return manifest;
}

function parseCheckpoint(path: string, manifest: RepriceManifest): RepriceCheckpoint {
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
  const body = record(readJson(path));
  if (body === null || body.version !== 1) throw new Error(`invalid checkpoint: ${path}`);
  const checkpoint = body as unknown as RepriceCheckpoint;
  if (
    checkpoint.planSha256 !== manifest.planSha256 ||
    checkpoint.pricingSha256 !== manifest.pricingSha256 ||
    checkpoint.totalRows !== manifest.rows.length ||
    !Number.isSafeInteger(checkpoint.nextRowIndex) ||
    checkpoint.nextRowIndex < 0 ||
    checkpoint.nextRowIndex > checkpoint.totalRows
  ) {
    throw new Error(`checkpoint does not match manifest: ${path}`);
  }
  return checkpoint;
}

function appliedTotals(
  manifest: RepriceManifest,
  nextRowIndex: number,
): SupervisorStatus["totals"] {
  let appliedOldUsd = 0;
  let appliedNewUsd = 0;
  for (const row of manifest.rows.slice(0, nextRowIndex)) {
    appliedOldUsd += row.oldTotalUsd ?? 0;
    appliedNewUsd += row.newTotalUsd;
  }
  return {
    appliedOldUsd,
    appliedNewUsd,
    appliedDeltaUsd: appliedNewUsd - appliedOldUsd,
  };
}

function backupAggregateSha256(directory: string): string | null {
  if (!existsSync(directory)) return null;
  const names = readdirSync(directory)
    .filter((name) => /^batch-.*\.sqlite$/.test(name))
    .sort();
  if (names.length === 0) return null;
  const aggregate = createHash("sha256");
  for (const name of names) {
    const digest = createHash("sha256")
      .update(readFileSync(join(directory, name)))
      .digest("hex");
    aggregate.update(`${digest}  ${name}\n`);
  }
  return aggregate.digest("hex");
}

function loadConfig(): SupervisorConfig {
  const hostStateDir =
    process.env.HELM_REPRICE_STATE_DIR ?? "/opt/helm-api/data/pricing-reprice-v0.27.5";
  return {
    container: process.env.HELM_CONTAINER ?? "helm",
    hostDatabasePath: process.env.HELM_REPRICE_DB ?? "/opt/helm-api/data/helm.db",
    containerDatabasePath: process.env.HELM_REPRICE_CONTAINER_DB ?? "/app/data/helm.db",
    containerPricingPath: process.env.HELM_REPRICE_PRICING ?? "/app/config/pricing.yaml",
    hostStateDir,
    containerStateDir:
      process.env.HELM_REPRICE_CONTAINER_STATE_DIR ?? "/app/data/pricing-reprice-v0.27.5",
    statusPath:
      process.env.HELM_REPRICE_STATUS_PATH ?? join(hostStateDir, "supervisor.status.json"),
    startMs: parseTimestamp(
      process.env.HELM_REPRICE_START ?? "2026-06-30T00:00:00Z",
      "HELM_REPRICE_START",
    ),
    cutoffMs: parseTimestamp(
      process.env.HELM_REPRICE_CUTOFF ?? "2026-07-15T13:28:46+08:00",
      "HELM_REPRICE_CUTOFF",
    ),
    sampleIntervalMs: envNumber("HELM_REPRICE_SAMPLE_INTERVAL_MS", 10_000),
    unsafePollMs: envNumber("HELM_REPRICE_UNSAFE_POLL_MS", 30_000),
    batchDelayMs: envNumber("HELM_REPRICE_BATCH_DELAY_MS", 10_000),
    cooldownMs: envNumber("HELM_REPRICE_COOLDOWN_MS", 300_000),
    maxStageBatches: envNumber("HELM_REPRICE_MAX_STAGE_BATCHES", 50),
    thresholds: DEFAULT_SUPERVISOR_THRESHOLDS,
  };
}

class DockerHostOperations {
  private toolPath: string | null = null;

  constructor(private readonly config: SupervisorConfig) {}

  private async docker(args: readonly string[], timeoutMs = 60_000): Promise<CommandResult> {
    return runCommand("docker", args, { timeoutMs });
  }

  async discoverTool(): Promise<string> {
    if (this.toolPath !== null) return this.toolPath;
    const result = await this.docker([
      "exec",
      this.config.container,
      "find",
      "/app",
      "-path",
      "*historical-cost-reprice.js",
      "-type",
      "f",
      "-print",
      "-quit",
    ]);
    const path = result.stdout.trim();
    if (path.length === 0) throw new Error("historical repricer tool not found in container");
    this.toolPath = path;
    return path;
  }

  async collectSample(logSince: string): Promise<SupervisorSample> {
    const capturedAt = new Date().toISOString();
    const [stats, inspect, health, logs] = await Promise.all([
      this.docker([
        "stats",
        "--no-stream",
        "--format",
        "{{.CPUPerc}}\t{{.MemPerc}}",
        this.config.container,
      ]),
      this.docker([
        "inspect",
        "--format",
        "{{.RestartCount}}\t{{.State.OOMKilled}}\t{{.State.Health.Status}}",
        this.config.container,
      ]),
      this.docker([
        "exec",
        this.config.container,
        "node",
        "--input-type=module",
        "--eval",
        'const started=performance.now();const response=await fetch("http://127.0.0.1:8080/healthz",{signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:response.status,latencyMs:performance.now()-started}));',
      ]),
      this.docker(["logs", "--since", logSince, this.config.container], 30_000),
    ]);
    const [cpuText = "", memoryText = ""] = stats.stdout.trim().split("\t");
    const [restartsText = "", oomText = "", containerHealth = ""] = inspect.stdout
      .trim()
      .split("\t");
    if (containerHealth !== "healthy") throw new Error(`container health is ${containerHealth}`);
    const healthBody = record(JSON.parse(health.stdout));
    if (healthBody === null) throw new Error("invalid health probe output");
    const memInfo = readFileSync("/proc/meminfo", "utf8");
    const memMatch = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(memInfo);
    if (memMatch?.[1] === undefined) throw new Error("MemAvailable missing from /proc/meminfo");
    const load1 = Number(readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/)[0]);
    const walPath = `${this.config.hostDatabasePath}-wal`;
    const fs = statfsSync(dirname(this.config.hostDatabasePath));
    const signals = parseStructuredLogSignals(`${logs.stdout}\n${logs.stderr}`);
    return {
      capturedAt,
      load1: finiteNumber(load1, "load1"),
      memAvailableBytes: Number(memMatch[1]) * 1024,
      helmCpuPercent: percent(cpuText, "Helm CPU"),
      helmMemoryPercent: percent(memoryText, "Helm memory"),
      healthStatus: finiteNumber(healthBody.status, "health status"),
      healthLatencyMs: finiteNumber(healthBody.latencyMs, "health latency"),
      walBytes: existsSync(walPath) ? statSync(walPath).size : 0,
      diskFreeBytes: fs.bavail * fs.bsize,
      restarts: finiteNumber(Number(restartsText), "restart count"),
      oomKilled: oomText === "true",
      ...signals,
    };
  }

  async planWindow(window: HistoricalWindow): Promise<void> {
    const tool = await this.discoverTool();
    await this.docker(
      [
        "exec",
        this.config.container,
        "node",
        tool,
        "--db",
        this.config.containerDatabasePath,
        "--pricing",
        this.config.containerPricingPath,
        "--from-ms",
        String(window.fromMs),
        "--to-ms",
        String(window.toMs),
        "--mode",
        "best-evidence",
        "--manifest",
        `${this.config.containerStateDir}/${window.name}.json`,
      ],
      10 * 60_000,
    );
  }

  async applyBatch(
    window: HistoricalWindow,
    manifest: RepriceManifest,
  ): Promise<RepriceCheckpoint> {
    const tool = await this.discoverTool();
    const result = await this.docker(
      [
        "exec",
        this.config.container,
        "node",
        tool,
        "--db",
        this.config.containerDatabasePath,
        "--pricing",
        this.config.containerPricingPath,
        "--apply-manifest",
        `${this.config.containerStateDir}/${window.name}.json`,
        "--expected-plan-sha256",
        manifest.planSha256,
        "--checkpoint",
        `${this.config.containerStateDir}/${window.name}.progress.json`,
        "--backup-dir",
        `${this.config.containerStateDir}/${window.name}.backups`,
        "--batch-size",
        "100",
        "--max-batches",
        "1",
        "--batch-delay-ms",
        "0",
        "--max-wal-bytes",
        String(this.config.thresholds.stopWalBytes),
        "--min-free-bytes",
        String(this.config.thresholds.stopDiskBytes),
        "--health-url",
        "http://127.0.0.1:8080/healthz",
      ],
      90_000,
    );
    return JSON.parse(result.stdout) as RepriceCheckpoint;
  }

  async verifyRows(
    window: HistoricalWindow,
    manifest: RepriceManifest,
    startRowIndex: number,
    endRowIndex: number,
  ): Promise<void> {
    const tool = await this.discoverTool();
    await this.docker(
      [
        "exec",
        this.config.container,
        "node",
        tool,
        "--db",
        this.config.containerDatabasePath,
        "--pricing",
        this.config.containerPricingPath,
        "--verify-manifest",
        `${this.config.containerStateDir}/${window.name}.json`,
        "--expected-plan-sha256",
        manifest.planSha256,
        "--start-row-index",
        String(startRowIndex),
        "--end-row-index",
        String(endRowIndex),
      ],
      10 * 60_000,
    );
  }
}

function windowPaths(
  config: SupervisorConfig,
  window: HistoricalWindow,
): {
  manifest: string;
  checkpoint: string;
  backups: string;
} {
  return {
    manifest: join(config.hostStateDir, `${window.name}.json`),
    checkpoint: join(config.hostStateDir, `${window.name}.progress.json`),
    backups: join(config.hostStateDir, `${window.name}.backups`),
  };
}

function findActiveWindow(
  config: SupervisorConfig,
  windows: readonly HistoricalWindow[],
): {
  window: HistoricalWindow;
  manifest: RepriceManifest | null;
  checkpoint: RepriceCheckpoint | null;
} | null {
  for (const window of windows) {
    const paths = windowPaths(config, window);
    if (!existsSync(paths.manifest)) return { window, manifest: null, checkpoint: null };
    const manifest = parseManifest(paths.manifest, window);
    const checkpoint = parseCheckpoint(paths.checkpoint, manifest);
    if (!checkpoint.completed) return { window, manifest, checkpoint };
  }
  return null;
}

function completedWindowCount(
  config: SupervisorConfig,
  windows: readonly HistoricalWindow[],
): number {
  let count = 0;
  for (const window of windows) {
    const paths = windowPaths(config, window);
    if (!existsSync(paths.manifest)) break;
    const manifest = parseManifest(paths.manifest, window);
    if (!parseCheckpoint(paths.checkpoint, manifest).completed) break;
    count += 1;
  }
  return count;
}

export async function runSupervisor(config = loadConfig()): Promise<void> {
  const windows = buildUtcWindows(config.startMs, config.cutoffMs);
  const operations = new DockerHostOperations(config);
  const startedAt = new Date().toISOString();
  let stopping = false;
  let stageBatches = 0;
  let stageStartRowIndex = 0;
  let recoveryRequired = true;
  let runtimeState: RuntimeSafetyState = {
    highCpuSamples: 0,
    slowHealthSamples: 0,
    baselineRestarts: 0,
  };
  let status: SupervisorStatus = {
    version: 1,
    phase: "starting",
    updatedAt: startedAt,
    startedAt,
    activeWindow: null,
    checkpoint: null,
    stageBatches: 0,
    completedWindows: completedWindowCount(config, windows),
    totalWindows: windows.length,
    sample: null,
    reasons: [],
    lastError: null,
    totals: null,
    backupAggregateSha256: null,
  };
  const writeStatus = (updates: Partial<SupervisorStatus>): void => {
    status = { ...status, ...updates, updatedAt: new Date().toISOString() };
    atomicWriteJson(config.statusPath, status);
  };
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  writeStatus({});

  let active = findActiveWindow(config, windows);
  if (active === null) {
    writeStatus({ phase: "complete", completedWindows: windows.length });
    return;
  }
  runtimeState.baselineRestarts = (
    await operations.collectSample(new Date().toISOString())
  ).restarts;

  while (!stopping) {
    try {
      active = findActiveWindow(config, windows);
      if (active === null) {
        writeStatus({
          phase: "complete",
          activeWindow: null,
          checkpoint: null,
          completedWindows: windows.length,
          reasons: [],
          lastError: null,
        });
        return;
      }

      if (shouldRunPreflight(stageBatches, recoveryRequired)) {
        const preflightSamples: SupervisorSample[] = [];
        while (!stopping) {
          const since = new Date(Date.now() - 10 * 60_000).toISOString();
          const sample = await operations.collectSample(since);
          preflightSamples.push(sample);
          if (preflightSamples.length > 3) preflightSamples.shift();
          const preflight = evaluatePreflight(preflightSamples, config.thresholds);
          writeStatus({
            phase: "waiting_safety",
            activeWindow: active.window.name,
            sample,
            reasons: preflight.reasons,
            lastError: null,
          });
          if (preflight.safe) {
            runtimeState = {
              highCpuSamples: 0,
              slowHealthSamples: 0,
              baselineRestarts: sample.restarts,
            };
            recoveryRequired = false;
            break;
          }
          await sleep(preflightSamples.length < 3 ? config.sampleIntervalMs : config.unsafePollMs);
        }
        if (stopping) break;
      }

      if (active.manifest === null) {
        writeStatus({ phase: "planning", activeWindow: active.window.name, reasons: [] });
        await operations.planWindow(active.window);
        active = findActiveWindow(config, windows);
        if (
          active === null ||
          active.manifest === null ||
          active.window.name !== status.activeWindow
        ) {
          continue;
        }
      }

      const manifest = active.manifest;
      let checkpoint =
        active.checkpoint ??
        parseCheckpoint(windowPaths(config, active.window).checkpoint, manifest);
      if (stageBatches === 0) stageStartRowIndex = checkpoint.nextRowIndex;
      const sample = await operations.collectSample(new Date(Date.now() - 15_000).toISOString());
      const safety = evaluateRuntimeSafety(sample, runtimeState, config.thresholds);
      runtimeState = safety.state;
      if (safety.stop) {
        stageBatches = 0;
        recoveryRequired = true;
        writeStatus({
          phase: "waiting_safety",
          sample,
          reasons: safety.reasons,
          checkpoint: {
            nextRowIndex: checkpoint.nextRowIndex,
            totalRows: checkpoint.totalRows,
            completed: checkpoint.completed,
          },
        });
        await sleep(config.unsafePollMs);
        continue;
      }

      const beforeRowIndex = checkpoint.nextRowIndex;
      writeStatus({
        phase: "applying",
        activeWindow: active.window.name,
        sample,
        reasons: [],
        stageBatches,
        checkpoint: {
          nextRowIndex: checkpoint.nextRowIndex,
          totalRows: checkpoint.totalRows,
          completed: checkpoint.completed,
        },
        totals: appliedTotals(manifest, checkpoint.nextRowIndex),
      });
      checkpoint = await operations.applyBatch(active.window, manifest);
      await operations.verifyRows(active.window, manifest, beforeRowIndex, checkpoint.nextRowIndex);
      stageBatches += 1;
      writeStatus({
        phase: checkpoint.completed ? "cooling" : "applying",
        checkpoint: {
          nextRowIndex: checkpoint.nextRowIndex,
          totalRows: checkpoint.totalRows,
          completed: checkpoint.completed,
        },
        stageBatches,
        completedWindows: completedWindowCount(config, windows),
        totals: appliedTotals(manifest, checkpoint.nextRowIndex),
        lastError: null,
      });

      if (checkpoint.completed) {
        await operations.verifyRows(active.window, manifest, 0, checkpoint.totalRows);
        writeStatus({
          phase: "cooling",
          completedWindows: completedWindowCount(config, windows),
          backupAggregateSha256: backupAggregateSha256(windowPaths(config, active.window).backups),
        });
        const cooldownEnd = Date.now() + config.cooldownMs;
        while (!stopping && Date.now() < cooldownEnd) {
          const cooldownSample = await operations.collectSample(
            new Date(Date.now() - 60_000).toISOString(),
          );
          writeStatus({ phase: "cooling", sample: cooldownSample });
          await sleep(Math.min(config.unsafePollMs, Math.max(0, cooldownEnd - Date.now())));
        }
        stageBatches = 0;
        recoveryRequired = true;
        continue;
      }

      if (stageBatches >= config.maxStageBatches) {
        await operations.verifyRows(
          active.window,
          manifest,
          stageStartRowIndex,
          checkpoint.nextRowIndex,
        );
        writeStatus({
          phase: "cooling",
          backupAggregateSha256: backupAggregateSha256(windowPaths(config, active.window).backups),
        });
        const cooldownEnd = Date.now() + config.cooldownMs;
        while (!stopping && Date.now() < cooldownEnd) {
          const cooldownSample = await operations.collectSample(
            new Date(Date.now() - 60_000).toISOString(),
          );
          writeStatus({ phase: "cooling", sample: cooldownSample });
          await sleep(Math.min(config.unsafePollMs, Math.max(0, cooldownEnd - Date.now())));
        }
        stageBatches = 0;
        recoveryRequired = true;
        continue;
      }
      await sleep(config.batchDelayMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recoveryRequired = true;
      writeStatus({ phase: "waiting_safety", lastError: message, reasons: [message] });
      await sleep(config.unsafePollMs);
    }
  }
}

const entrypoint = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check-config")) {
    const config = loadConfig();
    const windows = buildUtcWindows(config.startMs, config.cutoffMs);
    process.stdout.write(
      `${JSON.stringify({
        statusPath: config.statusPath,
        windows: windows.length,
        firstWindow: windows[0]?.name ?? null,
        lastWindow: windows.at(-1)?.name ?? null,
        cutoff: new Date(config.cutoffMs).toISOString(),
        batchSize: 100,
        maxStageRows: config.maxStageBatches * 100,
      })}\n`,
    );
  } else {
    runSupervisor().catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  }
}
