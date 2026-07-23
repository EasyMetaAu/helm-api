import {
  type InsertPayloadInput,
  type InsertTelemetryInput,
  runtimeMemoryBudget,
  type TelemetryStore,
} from "@helm/core";

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
  // Hard cap on the in-memory BYTE footprint of the buffered inserts. The real OOM
  // risk isn't row count — a single payload is 6-7MB, so 10_000 rows × 7MB ≈ 70GB.
  // Past this budget the queue sheds buffered writes (payload first — see
  // shedBufferedWrite) so a downstream stall (e.g. the 4am VACUUM holding the write
  // lock) can never balloon the heap. maxDepth stays as a row-count backstop; EITHER
  // limit tripping triggers a shed/reject. Default scales from the V8 heap limit.
  maxBytes?: number;
  // Flush a buffer eagerly once its accumulated bytes reach this, so a few giant
  // payloads can't coalesce into a multi-hundred-MB single transaction (maxBatch=256
  // rows × 7MB). Independent of maxBatch (the row-count eager-flush). Default
  // maxBytes/4.
  flushBytes?: number;
  // Optional hook fired AFTER each enqueued task settles (success or failure). The
  // composition root wires this to memoryWorker.wake() so a memory observe landing
  // here schedules the debounced drain — request-driven memory formation without
  // putting the worker on the request's critical path. Fail-open: a throw is logged,
  // never allowed to poison the task chain.
  onTaskDrain?: () => void;
}

export interface WriteQueue {
  // Defer a telemetry decision insert (batched, fail-open, runs after the response).
  enqueueTelemetry(input: InsertTelemetryInput): void;
  // Defer a payload upsert (batched, fail-open).
  enqueuePayload(input: InsertPayloadInput): void;
  // Defer a session transcript write while charging the retained request body
  // against the same byte/depth budget. Payload rows are shed first; if that is
  // insufficient, the session write itself is rejected before audit telemetry.
  enqueueSession(task: () => Promise<void>, bytes: number): void;
  // Defer a fail-open side-effect (memory observe, retention prune, …). Tasks run
  // sequentially in FIFO order, so callers can rely on inbound-before-outbound.
  // `wakeOnSettle` fires onTaskDrain after THIS task settles — set it only on the
  // turn's FINAL write (the outbound observe) so the memory worker is woken once the
  // whole turn is persisted, never mid-turn after the inbound-only write.
  enqueueTask(
    task: () => Promise<void>,
    opts?: { wakeOnSettle?: boolean; retainedBytes?: number },
  ): void;
  // Drain everything currently buffered/queued and resolve when the DB has it.
  flush(): Promise<void>;
  // Maintenance barrier: reject new deferred writes, then drain everything admitted.
  pauseAndFlush(): Promise<void>;
  resume(): void;
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
  const maxBytes = deps.maxBytes ?? runtimeMemoryBudget().writeQueueBytes;
  const flushBytes = deps.flushBytes ?? Math.floor(maxBytes / 4);
  const jsonAmplification = runtimeMemoryBudget().jsonAmplification;

  let telemetryBuf: InsertTelemetryInput[] = [];
  let payloadBuf: InsertPayloadInput[] = [];
  // Parallel byte-cost arrays kept in lock-step with the buffers above (same index =
  // same row). We never re-stringify a buffered entry to weigh it: the cost is
  // computed ONCE at enqueue (a cheap .length sum of the already-serialized JSON
  // fields) and the running total is adjusted by +cost on push / -cost on
  // shed|flush. That keeps backpressure O(1) amortized instead of turning the admit
  // check into an O(buffer) CPU hotspot.
  let telemetryBytes: number[] = [];
  let payloadBytes: number[] = [];
  let bufferedBytes = 0;
  // Bytes that have been flushed into the write chain but whose commit hasn't landed
  // yet — they still occupy the heap (the batch closures retain them). Counted toward
  // the byte budget so a STALLED writer (the 4am VACUUM holding the write lock) can't
  // let repeated flushes pile up unbounded batches behind the first blocked write.
  // Incremented at flush, released when each commit settles.
  let inFlightBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let paused = false;
  // All DB writes (batch flushes) run on this serial chain so two flushes can never
  // interleave; flush()/stop() await its tail.
  let writeChain: Promise<void> = Promise.resolve();
  // Side-effect tasks run on their own serial FIFO chain.
  let taskChain: Promise<void> = Promise.resolve();
  let pendingTasks = 0;
  let pendingSessionBytes = 0;
  let pendingTaskBytes = 0;

  const depth = (): number => telemetryBuf.length + payloadBuf.length + pendingTasks;

  // Cheap, allocation-free worst-case V8 estimate: retained JS strings may occupy
  // two bytes per UTF-16 code unit. Object/array overhead is small beside the bodies.
  const payloadCost = (input: InsertPayloadInput): number =>
    2 *
    (input.requestJson.length +
      (input.responseJson?.length ?? 0) +
      (input.upstreamRequestJson?.length ?? 0));

  // Telemetry rows are tiny vs payloads, but a redacted decision can still be a few KB.
  // Approximate it once at enqueue with a single stringify of the decision (the bulk
  // of the row) — never recomputed afterward; the cached cost rides the byte arrays.
  const telemetryCost = (input: InsertTelemetryInput): number => {
    try {
      return JSON.stringify(input.decision).length * 2;
    } catch {
      return 0; // a non-serializable decision can't bloat the heap as a string anyway
    }
  };

  // Deferred closures retain parsed/stringified request data as well as the original
  // strings. Charge their wire-size estimate using the process-derived multiplier.
  const retainedTaskCost = (bytes: number): number =>
    Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes * jsonAmplification) : 0;

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
    telemetryBytes = [];
    payloadBytes = [];
    // The bytes don't leave memory at flush — they move into the batch closures the
    // write chain retains until the commit lands. Move them from buffered → in-flight
    // (NOT zeroed) so admit() keeps counting them against maxBytes while the writer is
    // stalled; released when this batch's commit settles (success or failure).
    const flushedBytes = bufferedBytes;
    bufferedBytes = 0;
    inFlightBytes += flushedBytes;
    writeChain = writeChain
      .then(async () => {
        await writeTelemetry(tBatch);
        await writePayloads(pBatch);
      })
      .finally(() => {
        inFlightBytes -= flushedBytes;
      });
    return writeChain;
  };

  // Would admitting a row costing `incomingBytes` breach either limit? The row budget
  // is checked LAGGING (depth already at the cap) to preserve the original row-shed
  // behaviour; the byte budget is checked LOOKING-AHEAD over buffered + IN-FLIGHT +
  // incoming, so a single oversized payload is shed against BEFORE it lands AND a
  // stalled writer's queued-but-uncommitted batches still count — one 7MB row must not
  // overshoot the budget, and a write stall must not pile up batches past the cap.
  const overBudget = (incomingBytes: number): boolean =>
    depth() >= maxDepth ||
    bufferedBytes + inFlightBytes + pendingSessionBytes + pendingTaskBytes + incomingBytes >
      maxBytes;

  const shedPayload = (): boolean => {
    if (payloadBuf.length === 0) return false;
    payloadBuf.shift();
    bufferedBytes -= payloadBytes.shift() ?? 0;
    log("writequeue.overflow");
    return true;
  };

  // Drop the oldest buffered insert to relieve a depth/byte overflow. Tasks are never
  // dropped mid-chain (they're already scheduled); only buffered inserts are shed.
  // Priority: shed PAYLOAD (debug capture) before TELEMETRY (audit-critical). When a
  // stall forces a choice we keep the decision record and sacrifice the verbatim body
  // — and payloads are also where the bytes are (6-7MB each), so dropping them first
  // reclaims the most heap per shed. Byte counts are decremented in lock-step so the
  // running total never drifts.
  const shedBufferedWrite = (): boolean => {
    if (shedPayload()) return true;
    if (telemetryBuf.length > 0) {
      telemetryBuf.shift();
      bufferedBytes -= telemetryBytes.shift() ?? 0;
    } else {
      return false;
    }
    log("writequeue.overflow");
    return true;
  };

  const admitBufferedWrite = (incomingBytes: number): boolean => {
    if (!overBudget(incomingBytes)) return true;
    // Keep shedding until BOTH limits clear (a single 7MB payload can blow the byte
    // budget while many tiny rows blow the row budget). Stop if nothing is left to drop
    // (the incoming write alone is larger than the whole budget).
    while (overBudget(incomingBytes) && shedBufferedWrite()) {
      /* shed until under budget or empty */
    }
    if (!overBudget(incomingBytes)) return true;
    log("writequeue.overflow");
    return false;
  };

  return {
    enqueueTelemetry(input: InsertTelemetryInput): void {
      if (stopped) return;
      if (paused) {
        log("writequeue.paused");
        return;
      }
      const cost = telemetryCost(input);
      if (!admitBufferedWrite(cost)) return;
      telemetryBuf.push(input);
      telemetryBytes.push(cost);
      bufferedBytes += cost;
      // Eager flush on EITHER the row threshold or the byte threshold, so neither a
      // burst of rows nor a few giant rows can grow an oversized single transaction.
      if (telemetryBuf.length >= maxBatch || bufferedBytes >= flushBytes) void doFlush();
      else scheduleTimer();
    },

    enqueuePayload(input: InsertPayloadInput): void {
      if (stopped) return;
      if (paused) {
        log("writequeue.paused");
        return;
      }
      const cost = payloadCost(input);
      if (!admitBufferedWrite(cost)) return;
      payloadBuf.push(input);
      payloadBytes.push(cost);
      bufferedBytes += cost;
      if (payloadBuf.length >= maxBatch || bufferedBytes >= flushBytes) void doFlush();
      else scheduleTimer();
    },

    enqueueSession(task: () => Promise<void>, bytes: number): void {
      if (stopped) return;
      if (paused) {
        log("writequeue.paused");
        return;
      }
      const cost = retainedTaskCost(bytes);
      while (overBudget(cost) && shedPayload()) {
        /* payload is less valuable than a semantic session transcript */
      }
      if (overBudget(cost)) {
        log("writequeue.session_overflow");
        return;
      }
      pendingTasks++;
      pendingSessionBytes += cost;
      taskChain = taskChain.then(async () => {
        try {
          await task();
        } catch {
          log("writequeue.session_failed");
        } finally {
          pendingTasks--;
          pendingSessionBytes -= cost;
        }
      });
    },

    enqueueTask(
      task: () => Promise<void>,
      opts?: { wakeOnSettle?: boolean; retainedBytes?: number },
    ): void {
      if (stopped) return;
      if (paused) {
        log("writequeue.paused");
        return;
      }
      const cost = retainedTaskCost(opts?.retainedBytes ?? 0);
      while (overBudget(cost) && shedPayload()) {
        /* payload capture is less valuable than a deferred semantic write */
      }
      if (overBudget(cost)) {
        log("writequeue.task_overflow");
        return;
      }
      const wakeOnSettle = opts?.wakeOnSettle === true;
      pendingTasks++;
      pendingTaskBytes += cost;
      taskChain = taskChain.then(async () => {
        try {
          await task();
        } catch {
          log("writequeue.task_failed");
        } finally {
          pendingTasks--;
          pendingTaskBytes -= cost;
          // Fire the post-task hook (memory-worker wake) ONLY for tasks that opted in
          // — the turn's final/outbound observe. Waking after the inbound-only write
          // could drain the observer job before the assistant turn is persisted.
          // Fail-open: a throwing hook must never poison the FIFO chain.
          if (wakeOnSettle && deps.onTaskDrain !== undefined) {
            try {
              deps.onTaskDrain();
            } catch {
              log("writequeue.on_task_drain_failed");
            }
          }
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

    async pauseAndFlush(): Promise<void> {
      paused = true;
      clearTimer();
      await doFlush();
      await writeChain;
      await taskChain;
    },

    resume(): void {
      if (!stopped) paused = false;
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
