import { stat, statfs } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { runtimeMemoryBudget } from "../../runtime/memory-budget.js";

export function shouldRunVacuumForFreelist(args: {
  freelistPages: number;
  totalPages: number;
}): boolean {
  if (
    !Number.isSafeInteger(args.freelistPages) ||
    args.freelistPages < 0 ||
    !Number.isSafeInteger(args.totalPages) ||
    args.totalPages <= 0
  ) {
    throw new Error("invalid sqlite page counts");
  }
  if (args.freelistPages === 0) return false;
  return args.freelistPages * 20 >= args.totalPages;
}

export function assertVacuumMemoryCapacity(args: {
  processLimitBytes: number;
  availableBytes: number;
}): void {
  if (
    !Number.isFinite(args.processLimitBytes) ||
    args.processLimitBytes <= 0 ||
    !Number.isFinite(args.availableBytes) ||
    args.availableBytes < 0
  ) {
    throw new Error("invalid process memory capacity");
  }
  const requiredBytes = Math.floor(args.processLimitBytes * 0.25);
  if (args.availableBytes < requiredBytes) {
    throw new Error(
      `insufficient memory for sqlite VACUUM: required=${requiredBytes} available=${Math.floor(args.availableBytes)}`,
    );
  }
}

export function assertVacuumDiskCapacity(args: {
  databaseBytes: bigint;
  walBytes: bigint;
  availableBytes: bigint;
}): void {
  const requiredBytes = (args.databaseBytes + args.walBytes) * 2n;
  if (args.availableBytes < requiredBytes) {
    throw new Error(
      `insufficient disk space for sqlite VACUUM: required=${requiredBytes} available=${args.availableBytes}`,
    );
  }
}

async function optionalFileSize(path: string): Promise<bigint> {
  try {
    return (await stat(path, { bigint: true })).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0n;
    throw error;
  }
}

async function assertVacuumFileSystemCapacity(databasePath: string): Promise<void> {
  const [databaseBytes, walBytes, fileSystem] = await Promise.all([
    stat(databasePath, { bigint: true }).then((value) => value.size),
    optionalFileSize(`${databasePath}-wal`),
    statfs(dirname(databasePath), { bigint: true }),
  ]);
  assertVacuumDiskCapacity({
    databaseBytes,
    walBytes,
    availableBytes: fileSystem.bavail * fileSystem.bsize,
  });
}

const vacuumWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlite3Path);

const message = (error) => error instanceof Error ? error.message : String(error);
let result;
let sqlite;
try {
  sqlite = new Database(workerData.databasePath, { fileMustExist: true });
  sqlite.pragma("busy_timeout = 0");
  const checkpoint = sqlite.pragma("wal_checkpoint(TRUNCATE)");
  if (!Array.isArray(checkpoint) || checkpoint.length !== 1 || checkpoint[0].busy !== 0) {
    throw new Error("sqlite checkpoint is busy");
  }

  const freelistCount = Number(sqlite.pragma("freelist_count", { simple: true }));
  if (!Number.isFinite(freelistCount) || freelistCount < 0) {
    throw new Error("invalid sqlite freelist_count");
  }

  if (freelistCount === 0) {
    result = { ok: true, noOp: true };
  } else {
    const normalCacheSize = Number(sqlite.pragma("cache_size", { simple: true }));
    const normalTempStore = Number(sqlite.pragma("temp_store", { simple: true }));
    let primaryError;
    const restoreErrors = [];
    try {
      sqlite.pragma("busy_timeout = 5000");
      sqlite.pragma("temp_store = FILE");
      sqlite.pragma("cache_size = -" + workerData.maintenanceCacheKiB);
      sqlite.pragma("shrink_memory");
      sqlite.exec("VACUUM");
    } catch (error) {
      primaryError = error;
    }
    try {
      sqlite.pragma("temp_store = " + normalTempStore);
    } catch (error) {
      restoreErrors.push("temp_store: " + message(error));
    }
    try {
      sqlite.pragma("cache_size = " + normalCacheSize);
    } catch (error) {
      restoreErrors.push("cache_size: " + message(error));
    }
    if (primaryError || restoreErrors.length > 0) {
      const details = restoreErrors.length > 0 ? "; restore failed: " + restoreErrors.join(", ") : "";
      throw new Error((primaryError ? message(primaryError) : "sqlite pragma restore failed") + details);
    }
    result = { ok: true, noOp: false };
  }
} catch (error) {
  result = { ok: false, error: message(error) };
}

if (sqlite) {
  try {
    sqlite.close();
  } catch (error) {
    if (result && result.ok) result = { ok: false, error: "sqlite close failed: " + message(error) };
  }
}
parentPort.postMessage(result);
`;

interface VacuumWorkerResult {
  ok: boolean;
  error?: string;
}

function runVacuumWorker(args: {
  databasePath: string;
  maintenanceCacheKiB: number;
}): Promise<void> {
  const betterSqlite3Path = createRequire(import.meta.url).resolve("better-sqlite3");
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const worker = new Worker(vacuumWorkerSource, {
      eval: true,
      workerData: { ...args, betterSqlite3Path },
    });
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    worker.once("message", (value: VacuumWorkerResult) => {
      if (settled) return;
      settled = true;
      if (value?.ok) resolvePromise();
      else rejectPromise(new Error(value?.error ?? "sqlite VACUUM worker failed"));
    });
    worker.once("error", rejectOnce);
    worker.once("exit", (code) => {
      if (!settled) rejectOnce(new Error(`sqlite VACUUM worker exited before reporting: ${code}`));
    });
  });
}

export async function vacuumSqlite(
  sqlite: Database.Database,
  options: {
    maintenanceCacheBytes: number;
    processLimitBytes?: number;
    availableMemoryBytes?: number;
  },
): Promise<void> {
  if (!Number.isFinite(options.maintenanceCacheBytes) || options.maintenanceCacheBytes <= 0) {
    throw new Error("maintenanceCacheBytes must be positive");
  }
  if (sqlite.name === ":memory:" || sqlite.name === "") {
    throw new Error("sqlite VACUUM worker requires a file-backed database");
  }
  const freelistCount = Number(sqlite.pragma("freelist_count", { simple: true }));
  if (!Number.isFinite(freelistCount) || freelistCount < 0) {
    throw new Error("invalid sqlite freelist_count");
  }
  const pageCount = Number(sqlite.pragma("page_count", { simple: true }));
  if (!shouldRunVacuumForFreelist({ freelistPages: freelistCount, totalPages: pageCount })) return;

  const databasePath = resolve(sqlite.name);
  await assertVacuumFileSystemCapacity(databasePath);
  sqlite.pragma("shrink_memory");
  assertVacuumMemoryCapacity({
    processLimitBytes: options.processLimitBytes ?? runtimeMemoryBudget().processLimitBytes,
    availableBytes: options.availableMemoryBytes ?? process.availableMemory(),
  });
  await runVacuumWorker({
    databasePath,
    maintenanceCacheKiB: Math.max(1, Math.floor(options.maintenanceCacheBytes / 1024)),
  });
}
