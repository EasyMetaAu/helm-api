// Structured logger. JSON line output by default. Every log line is expected to
// carry a trace_id (propagated end to end). Per CLAUDE.md principle 7, callers
// must redact secrets/payloads before logging (use @helm/core redact()).

export type LogLevel = "debug" | "info" | "warn" | "error";

// Severity ordering for runtime gating: a line is emitted only when its level is
// at or above the logger's current floor (debug < info < warn < error).
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  // Change the verbosity floor at runtime (admin "System Settings" → log_level).
  // Optional so lightweight test fakes (`{ log: () => {} }`) still satisfy Logger.
  setLevel?(level: LogLevel): void;
}

// JSON-line logger writing to a sink (stdout by default). Pure transport — it
// does NOT redact; that is the caller's responsibility. The verbosity floor is
// mutable via setLevel() so the admin can change it live without a restart.
export function createJsonLogger(
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  initialLevel: LogLevel = "info",
): Logger {
  let level: LogLevel = initialLevel;
  return {
    log(lvl, message, fields = {}) {
      if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return; // below the floor → dropped
      sink(JSON.stringify({ level: lvl, message, ...fields, ts: new Date().toISOString() }));
    },
    setLevel(next) {
      level = next;
    },
  };
}
