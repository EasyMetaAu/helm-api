import type { InsertPayloadInput, InsertTelemetryInput, TelemetryStore } from "@helm/core";

// The slice of TelemetryStore the queue drives. Batch methods are optional (the
// queue falls back to per-row writes when an adapter lacks them).
export type WriteQueueTelemetry = Pick<
  TelemetryStore,
  "insert" | "insertMany" | "insertPayload" | "insertPayloads"
>;

export interface WriteQueueDeps {
  telemetry: WriteQueueTelemetry;
  // Structured-log sink (fail-open diagnostics). Never throws.
  log: (message: string) => void;
  // Idle flush cadence for the accumulated insert buffers (ms). Default 25.
  flushIntervalMs?: number;
  // Flush a buffer eagerly once it reaches this many rows. Default 256.
  maxBatch?: number;
  // Hard cap on in-memory backlog (telemetry + payloads + queued tasks). Past it,
  // the oldest buffered write is dropped (logged) so a write stall can never grow
  // the heap without bound. Default 10_000.
  maxDepth?: number;
}

export interface WriteQueue {
  // Defer a telemetry decision insert (batched, fail-open, runs after the response).
  enqueueTelemetry(input: InsertTelemetryInput): void;
  // Defer a payload upsert (batched, fail-open).
  enqueuePayload(input: InsertPayloadInput): void;
  // Defer a fail-open side-effect (memory observe, retention prune, …). Tasks run
  // sequentially in FIFO order, so callers can rely on inbound-before-outbound.
  enqueueTask(task: () => Promise<void>): void;
  // Drain everything currently buffered/queued and resolve when the DB has it.
  flush(): Promise<void>;
  // Stop the idle timer and flush once. Idempotent. For graceful shutdown.
  stop(): Promise<void>;
  // Current backlog size (for tests / metrics).
  readonly depth: number;
}

// In-process deferred + batched write queue (perf). The four AI faces enqueue their
// fail-open writes (telemetry, payload capture, memory observe) here AFTER the
// response is produced, so a synchronous better-sqlite3 commit never sits on the
// request's critical path. Telemetry and payload inserts are coalesced into a single
// batched commit per flush (N commits → 1), which is what actually relieves the
// single event-loop thread under concurrency. Side-effect tasks run on one sequential
// FIFO chain so memory ordering (inbound before outbound) is preserved. Everything is
// fail-open: a write failure is logged, never thrown — it can never break a served
// request. Style mirrors core/queue/keyed-semaphore.ts (in-memory, injected log).
export function createWriteQueue(deps: WriteQueueDeps): WriteQueue {
  const { telemetry, log } = deps;
  const flushIntervalMs = deps.flushIntervalMs ?? 25;
  const maxBatch = deps.maxBatch ?? 256;
  const maxDepth = deps.maxDepth ?? 10_000;

  let telemetryBuf: InsertTelemetryInput[] = [];
  let payloadBuf: InsertPayloadInput[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // All DB writes (batch flushes) run on this serial chain so two flushes can never
  // interleave; flush()/stop() await its tail.
  let writeChain: Promise<void> = Promise.resolve();
  // Side-effect tasks run on their own serial FIFO chain.
  let taskChain: Promise<void> = Promise.resolve();
  let pendingTasks = 0;

  const depth = (): number => telemetryBuf.length + payloadBuf.length + pendingTasks;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleTimer = (): void => {
    if (timer !== null || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void doFlush();
    }, flushIntervalMs);
    // Don't keep the process alive purely for a pending flush.
    if (typeof timer.unref === "function") timer.unref();
  };

  // Write a telemetry batch as ONE commit, but fall back to per-row inserts if the
  // batch throws. A single bad row — e.g. a reused request_id hitting the unique
  // index — would otherwise abort the whole multi-row statement and drop EVERY
  // unrelated row in the same flush window. Per-row fallback loses only the offending
  // row (better-sqlite3 / pg multi-row INSERT is atomic, so nothing committed on the
  // failed batch — the fallback never double-writes).
  const writeTelemetry = async (batch: InsertTelemetryInput[]): Promise<void> => {
    if (batch.length === 0) return;
    if (telemetry.insertMany) {
      try {
        await telemetry.insertMany(batch);
        return;
      } catch {
        log("writequeue.telemetry_batch_fallback");
      }
    }
    for (const input of batch) {
      try {
        await telemetry.insert(input);
      } catch {
        log("writequeue.telemetry_insert_failed");
      }
    }
  };

  // Same batch-then-per-row resilience for payloads (their upsert tolerates a
  // duplicate request_id, but any other batch error must not drop the window).
  const writePayloads = async (batch: InsertPayloadInput[]): Promise<void> => {
    if (batch.length === 0) return;
    if (telemetry.insertPayloads) {
      try {
        await telemetry.insertPayloads(batch);
        return;
      } catch {
        log("writequeue.payload_batch_fallback");
      }
    }
    for (const input of batch) {
      try {
        await telemetry.insertPayload(input);
      } catch {
        log("writequeue.payload_insert_failed");
      }
    }
  };

  // Swap out the current buffers and append their writes to the serial chain.
  // Returns the chain tail so callers can await a full drain.
  const doFlush = (): Promise<void> => {
    clearTimer();
    if (telemetryBuf.length === 0 && payloadBuf.length === 0) return writeChain;
    const tBatch = telemetryBuf;
    const pBatch = payloadBuf;
    telemetryBuf = [];
    payloadBuf = [];
    writeChain = writeChain.then(async () => {
      await writeTelemetry(tBatch);
      await writePayloads(pBatch);
    });
    return writeChain;
  };

  // Drop the oldest buffered insert to stay under maxDepth. Tasks are never dropped
  // mid-chain (they're already scheduled); only buffered inserts are shed.
  const shedIfOverflow = (): void => {
    if (depth() < maxDepth) return;
    if (telemetryBuf.length >= payloadBuf.length && telemetryBuf.length > 0) telemetryBuf.shift();
    else if (payloadBuf.length > 0) payloadBuf.shift();
    log("writequeue.overflow");
  };

  return {
    enqueueTelemetry(input: InsertTelemetryInput): void {
      if (stopped) return;
      shedIfOverflow();
      telemetryBuf.push(input);
      if (telemetryBuf.length >= maxBatch) void doFlush();
      else scheduleTimer();
    },

    enqueuePayload(input: InsertPayloadInput): void {
      if (stopped) return;
      shedIfOverflow();
      payloadBuf.push(input);
      if (payloadBuf.length >= maxBatch) void doFlush();
      else scheduleTimer();
    },

    enqueueTask(task: () => Promise<void>): void {
      if (stopped) return;
      if (pendingTasks >= maxDepth) {
        log("writequeue.overflow");
        return;
      }
      pendingTasks++;
      taskChain = taskChain.then(async () => {
        try {
          await task();
        } catch {
          log("writequeue.task_failed");
        } finally {
          pendingTasks--;
        }
      });
    },

    async flush(): Promise<void> {
      // Flush buffers into the write chain, then await both chains. Tasks never
      // enqueue inserts, so a single drain pass settles everything.
      await doFlush();
      await writeChain;
      await taskChain;
    },

    async stop(): Promise<void> {
      stopped = true;
      clearTimer();
      await doFlush();
      await writeChain;
      await taskChain;
    },

    get depth(): number {
      return depth();
    },
  };
}
