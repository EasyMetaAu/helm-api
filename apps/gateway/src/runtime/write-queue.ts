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
  // producers wait for the current bounded backlog to drain. Default 10_000.
  maxDepth?: number;
  // Hard cap on the in-memory BYTE footprint of the buffered inserts. The real OOM
  // risk isn't row count — a single payload is 6-7MB, so 10_000 rows × 7MB ≈ 70GB.
  // Past this budget producers wait for the current backlog to drain, so a downstream
  // stall (e.g. the 4am VACUUM holding the write lock) cannot balloon the heap or lose
  // accepted work. maxDepth stays as a row-count backstop. Default scales from V8.
  maxBytes?: number;
  // Flush a buffer eagerly once its accumulated bytes reach this, so a few giant
  // payloads can't coalesce into a multi-hundred-MB single transaction (maxBatch=256
  // rows × 7MB). Independent of maxBatch (the row-count eager-flush). Default
  // maxBytes/4.
  flushBytes?: number;
  // Hard cap on producers waiting to enter the bounded queue. Their async frames
  // retain payloads/tasks too, so waiting work needs an independent ceiling.
  // Deferred writes are observational; overflow is dropped fail-open.
  maxPendingAdmissions?: number;
  maxPendingAdmissionBytes?: number;
  // Optional hook fired AFTER each enqueued task settles (success or failure). The
  // composition root wires this to memoryWorker.wake() so a memory observe landing
  // here schedules the debounced drain — request-driven memory formation without
  // putting the worker on the request's critical path. Fail-open: a throw is logged,
  // never allowed to poison the task chain.
  onTaskDrain?: () => void;
}

export interface WriteQueue {
  // Defer a telemetry decision insert (batched, fail-open, runs after the response).
  enqueueTelemetry(input: InsertTelemetryInput): Promise<void>;
  // Defer a payload upsert (batched, fail-open).
  enqueuePayload(input: InsertPayloadInput, isCurrent?: () => boolean): Promise<void>;
  // Defer a session transcript write while charging the retained request body
  // against the same byte/depth budget. When full, admission waits for the bounded
  // backlog instead of retaining another closure or dropping the transcript.
  enqueueSession(task: () => Promise<void>, bytes: number): Promise<void>;
  // Defer a fail-open side-effect (memory observe, retention prune, …). Tasks run
  // sequentially in FIFO order, so callers can rely on inbound-before-outbound.
  // `wakeOnSettle` fires onTaskDrain after THIS task settles — set it only on the
  // turn's FINAL write (the outbound observe) so the memory worker is woken once the
  // whole turn is persisted, never mid-turn after the inbound-only write.
  enqueueTask(
    task: () => Promise<void>,
    opts?: { wakeOnSettle?: boolean; retainedBytes?: number },
  ): Promise<void>;
  // Drain everything currently buffered/queued and resolve when the DB has it.
  flush(): Promise<void>;
  // Maintenance barrier: reject new deferred writes, then drain everything whose
  // admission started before the barrier.
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
  const maxPendingAdmissions = deps.maxPendingAdmissions ?? 256;
  const maxPendingAdmissionBytes = deps.maxPendingAdmissionBytes ?? maxBytes;
  const jsonAmplification = runtimeMemoryBudget().jsonAmplification;

  let telemetryBuf: InsertTelemetryInput[] = [];
  let payloadBuf: Array<{ input: InsertPayloadInput; isCurrent?: () => boolean }> = [];
  // Costs are computed once at admission and accumulated until the whole buffer moves
  // to the in-flight batch. No per-row cost arrays are needed because rows are never
  // shed after admission.
  let bufferedBytes = 0;
  // Bytes that have been flushed into the write chain but whose commit hasn't landed
  // yet — they still occupy the heap (the batch closures retain them). Counted toward
  // the byte budget so a STALLED writer (the 4am VACUUM holding the write lock) can't
  // let repeated flushes pile up unbounded batches behind the first blocked write.
  // Incremented at flush, released when each commit settles.
  let inFlightBytes = 0;
  let inFlightDepth = 0;
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
  // Serialize only the capacity check + append. Waiting work remains on the producing
  // request's async frame; it is not appended to the bounded write/task chains until
  // capacity is available.
  let admissionTail: Promise<void> = Promise.resolve();
  let pendingAdmissions = 0;
  let pendingAdmissionBytes = 0;

  const depth = (): number =>
    telemetryBuf.length + payloadBuf.length + inFlightDepth + pendingTasks;

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

  // Awaited admission must not pull deferred better-sqlite3 work back onto the
  // response path. Start side-effect tasks on the next event-loop turn.
  const deferTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  const writePayloads = async (
    batch: Array<{ input: InsertPayloadInput; isCurrent?: () => boolean }>,
  ): Promise<void> => {
    const current = batch
      .filter((queued) => queued.isCurrent?.() !== false)
      .map((queued) => queued.input);
    if (current.length === 0) return;
    if (telemetry.insertPayloads) {
      try {
        await telemetry.insertPayloads(current);
        return;
      } catch {
        log("writequeue.payload_batch_fallback");
      }
    }
    for (const input of current) {
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
    // The bytes don't leave memory at flush — they move into the batch closures the
    // write chain retains until the commit lands. Move them from buffered → in-flight
    // (NOT zeroed) so admit() keeps counting them against maxBytes while the writer is
    // stalled; released when this batch's commit settles (success or failure).
    const flushedBytes = bufferedBytes;
    const flushedDepth = tBatch.length + pBatch.length;
    bufferedBytes = 0;
    inFlightBytes += flushedBytes;
    inFlightDepth += flushedDepth;
    writeChain = writeChain
      .then(async () => {
        await writeTelemetry(tBatch);
        await writePayloads(pBatch);
      })
      .finally(() => {
        inFlightBytes -= flushedBytes;
        inFlightDepth -= flushedDepth;
      });
    return writeChain;
  };

  // Would admitting a row costing `incomingBytes` breach either limit? Both buffered
  // and IN-FLIGHT batches count: flushing into a stalled write chain must not create an
  // unbounded hidden queue of closures.
  const overBudget = (incomingBytes: number): boolean =>
    depth() >= maxDepth ||
    bufferedBytes + inFlightBytes + pendingSessionBytes + pendingTaskBytes + incomingBytes >
      maxBytes;

  const waitForCapacity = async (incomingBytes: number): Promise<void> => {
    while (overBudget(incomingBytes) && depth() > 0) {
      // Backpressure stays on the producing request. Only already-admitted work lives
      // in the queue; waiting producers do not append closures behind a stalled writer.
      const currentTaskTail = taskChain;
      await Promise.all([doFlush(), currentTaskTail]);
    }
    // One item may exceed the derived byte budget, but it is the only admitted item.
    // Its body already exists on the request path; admitting exactly one avoids a
    // deadlock while keeping the queue bounded by one item rather than an unbounded
    // chain of oversized closures.
  };

  const admit = async (incomingBytes: number, append: () => void): Promise<void> => {
    // The uncontended hot path is synchronous: the check and append are one JS turn.
    if (pendingAdmissions === 0 && (!overBudget(incomingBytes) || depth() === 0)) {
      append();
      return;
    }

    // The caller's suspended async frame retains `input` / `task` until it wins
    // admission. Do not turn a stalled store into an unbounded second queue.
    const pendingCost = Math.min(incomingBytes, maxPendingAdmissionBytes);
    if (
      pendingAdmissions >= maxPendingAdmissions ||
      pendingAdmissionBytes + pendingCost > maxPendingAdmissionBytes
    ) {
      log("writequeue.admission_dropped");
      return;
    }

    let release!: () => void;
    const previous = admissionTail;
    admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    pendingAdmissions++;
    pendingAdmissionBytes += pendingCost;
    await previous;
    try {
      if (overBudget(incomingBytes)) await waitForCapacity(incomingBytes);
      append();
    } finally {
      pendingAdmissions--;
      pendingAdmissionBytes -= pendingCost;
      release();
    }
  };

  return {
    async enqueueTelemetry(input: InsertTelemetryInput): Promise<void> {
      if (stopped) return;
      if (paused) {
        log("writequeue.paused");
        return;
      }
      const cost = telemetryCost(input);
      await admit(cost, () => {
        telemetryBuf.push(input);
        bufferedBytes += cost;
        // Eager flush on EITHER the row threshold or the byte threshold, so neither a
        // burst of rows nor a few giant rows can grow an oversized single transaction.
        if (telemetryBuf.length >= maxBatch || bufferedBytes >= flushBytes) void doFlush();
        else scheduleTimer();
      });
    },

    async enqueuePayload(input: InsertPayloadInput, isCurrent?: () => boolean): Promise<void> {
      if (stopped) return;
      if (paused) {
        log("writequeue.paused");
        return;
      }
      const cost = payloadCost(input);
      await admit(cost, () => {
        payloadBuf.push({ input, isCurrent });
        bufferedBytes += cost;
        if (payloadBuf.length >= maxBatch || bufferedBytes >= flushBytes) void doFlush();
        else scheduleTimer();
      });
    },

    async enqueueSession(task: () => Promise<void>, bytes: number): Promise<void> {
      if (stopped) return;
      if (paused) {
        log("writequeue.paused");
        return;
      }
      const cost = retainedTaskCost(bytes);
      await admit(cost, () => {
        pendingTasks++;
        pendingSessionBytes += cost;
        taskChain = taskChain.then(async () => {
          try {
            await deferTask();
            await task();
          } catch {
            log("writequeue.session_failed");
          } finally {
            pendingTasks--;
            pendingSessionBytes -= cost;
          }
        });
      });
    },

    async enqueueTask(
      task: () => Promise<void>,
      opts?: { wakeOnSettle?: boolean; retainedBytes?: number },
    ): Promise<void> {
      if (stopped) return;
      if (paused) {
        log("writequeue.paused");
        return;
      }
      const cost = retainedTaskCost(opts?.retainedBytes ?? 0);
      const wakeOnSettle = opts?.wakeOnSettle === true;
      await admit(cost, () => {
        pendingTasks++;
        pendingTaskBytes += cost;
        taskChain = taskChain.then(async () => {
          try {
            await deferTask();
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
      });
    },

    async flush(): Promise<void> {
      // Let every producer already waiting on capacity finish admission first, then
      // flush what they appended. Tasks never enqueue inserts, so one drain settles all.
      await admissionTail;
      await doFlush();
      await writeChain;
      await taskChain;
    },

    async pauseAndFlush(): Promise<void> {
      paused = true;
      clearTimer();
      await admissionTail;
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
      await admissionTail;
      await doFlush();
      await writeChain;
      await taskChain;
    },

    get depth(): number {
      return depth();
    },
  };
}
