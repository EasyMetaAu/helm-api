// Structured logger. JSON line output by default. Every log line is expected to
// carry a trace_id (propagated end to end). Per CLAUDE.md principle 7, callers
// must redact secrets/payloads before logging (use @helm/core redact()).

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

// JSON-line logger writing to a sink (stdout by default). Pure transport — it
// does NOT redact; that is the caller's responsibility.
export function createJsonLogger(
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  return {
    log(level, message, fields = {}) {
      sink(JSON.stringify({ level, message, ...fields, ts: new Date().toISOString() }));
    },
  };
}
