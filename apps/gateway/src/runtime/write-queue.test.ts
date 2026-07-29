import type { InsertPayloadInput, InsertTelemetryInput } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createWriteQueue, type WriteQueueTelemetry } from "./write-queue.js";

interface Sink extends WriteQueueTelemetry {
  readonly inserts: InsertTelemetryInput[];
  readonly manyCalls: number;
  readonly payloadCalls: InsertPayloadInput[];
  readonly payloadsManyCalls: number;
}

// A fake telemetry sink recording every call, with toggleable batch support so we
// can exercise both the batched path and the per-row fallback.
function fakeSink(opts: { batch?: boolean } = {}): Sink {
  const inserts: InsertTelemetryInput[] = [];
  const payloadCalls: InsertPayloadInput[] = [];
  const counters = { manyCalls: 0, payloadsManyCalls: 0 };
  const sink: Sink = {
    get inserts() {
      return inserts;
    },
    get payloadCalls() {
      return payloadCalls;
    },
    get manyCalls() {
      return counters.manyCalls;
    },
    get payloadsManyCalls() {
      return counters.payloadsManyCalls;
    },
    insert: vi.fn(async (i: InsertTelemetryInput) => {
      inserts.push(i);
      return { id: "x" };
    }),
    insertPayload: vi.fn(async (i: InsertPayloadInput) => {
      payloadCalls.push(i);
    }),
  };
  if (opts.batch ?? true) {
    sink.insertMany = vi.fn(async (xs: InsertTelemetryInput[]) => {
      counters.manyCalls++;
      inserts.push(...xs);
    });
    sink.insertPayloads = vi.fn(async (xs: InsertPayloadInput[]) => {
      counters.payloadsManyCalls++;
      payloadCalls.push(...xs);
    });
  }
  return sink;
}

function tele(id: string): InsertTelemetryInput {
  return {
    // The queue treats these as opaque — a minimal decision shape is enough.
    decision: { request_id: id } as never,
    apiKeyId: "k1",
    createdAt: new Date(0),
  };
}
function payload(id: string): InsertPayloadInput {
  return { requestId: id, requestJson: "{}", responseJson: null, createdAt: new Date(0) };
}
// A payload whose serialized JSON fields sum to roughly `bytes` (cheap length
// approximation the queue uses for its byte budget). The id stays distinct so we
// can tell which rows survive a shed.
function bigPayload(id: string, bytes: number): InsertPayloadInput {
  return {
    requestId: id,
    requestJson: "x".repeat(bytes),
    responseJson: null,
    createdAt: new Date(0),
  };
}

describe("createWriteQueue", () => {
  it("defers telemetry until flush, then writes them in ONE batch", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({ telemetry: sink, log: () => {}, flushIntervalMs: 10_000 });
    q.enqueueTelemetry(tele("a"));
    q.enqueueTelemetry(tele("b"));
    expect(sink.inserts).toHaveLength(0); // nothing written yet

    await q.flush();
    expect(sink.inserts.map((i) => (i.decision as { request_id: string }).request_id)).toEqual([
      "a",
      "b",
    ]);
    expect(sink.manyCalls).toBe(1); // one commit, not two
  });

  it("batches payloads in one commit and defers them until flush", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({ telemetry: sink, log: () => {}, flushIntervalMs: 10_000 });
    q.enqueuePayload(payload("a"));
    q.enqueuePayload(payload("b"));
    expect(sink.payloadCalls).toHaveLength(0);
    await q.flush();
    expect(sink.payloadCalls.map((p) => p.requestId)).toEqual(["a", "b"]);
    expect(sink.payloadsManyCalls).toBe(1);
  });

  it("auto-flushes once a buffer reaches maxBatch", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxBatch: 3,
    });
    q.enqueueTelemetry(tele("a"));
    q.enqueueTelemetry(tele("b"));
    q.enqueueTelemetry(tele("c")); // hits threshold → flush scheduled
    await q.flush(); // drain the in-flight threshold flush
    expect(sink.inserts).toHaveLength(3);
    expect(sink.manyCalls).toBe(1);
  });

  it("runs tasks in FIFO order and flush awaits them", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({ telemetry: sink, log: () => {}, flushIntervalMs: 10_000 });
    const order: string[] = [];
    q.enqueueTask(async () => {
      await Promise.resolve();
      order.push("first");
    });
    q.enqueueTask(async () => {
      order.push("second");
    });
    await q.flush();
    expect(order).toEqual(["first", "second"]);
  });

  it("is fail-open: a throwing task or write never rejects flush, and siblings still run", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
    });
    const ran: string[] = [];
    q.enqueueTask(async () => {
      throw new Error("boom");
    });
    q.enqueueTask(async () => {
      ran.push("ok");
    });
    await expect(q.flush()).resolves.toBeUndefined();
    expect(ran).toEqual(["ok"]); // the throw did not poison the chain
    expect(logs.some((l) => l.includes("task"))).toBe(true);
  });

  it("does not let a failing telemetry flush reject flush()", async () => {
    const sink = fakeSink();
    (sink.insertMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const logs: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
    });
    q.enqueueTelemetry(tele("a"));
    await expect(q.flush()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("telemetry"))).toBe(true);
  });

  it("on a batched-insert failure, falls back to per-row so one bad row never drops the batch", async () => {
    // Simulate a reused request_id in the 25ms window: the multi-row insertMany hits
    // the unique index and throws; per-row insert throws ONLY for the duplicate id.
    const written: string[] = [];
    const telemetry = {
      insert: vi.fn(async (i: InsertTelemetryInput) => {
        const id = (i.decision as unknown as { request_id: string }).request_id;
        if (id === "dup") throw new Error("UNIQUE constraint failed: telemetry.request_id");
        written.push(id);
        return { id: "x" };
      }),
      insertMany: vi.fn(async () => {
        throw new Error("UNIQUE constraint failed: telemetry.request_id");
      }),
      insertPayload: vi.fn(async () => {}),
      insertPayloads: vi.fn(async () => {}),
    } as unknown as WriteQueueTelemetry;
    const logs: string[] = [];
    const q = createWriteQueue({ telemetry, log: (m) => logs.push(m), flushIntervalMs: 10_000 });

    q.enqueueTelemetry(tele("a"));
    q.enqueueTelemetry(tele("dup"));
    q.enqueueTelemetry(tele("b"));
    await q.flush();

    // The duplicate is the ONLY row lost; its unrelated neighbors are preserved.
    expect(written.sort()).toEqual(["a", "b"]);
    expect(logs).toContain("writequeue.telemetry_batch_fallback");
  });

  it("falls back to per-row writes when the sink has no batch methods", async () => {
    const sink = fakeSink({ batch: false });
    const q = createWriteQueue({ telemetry: sink, log: () => {}, flushIntervalMs: 10_000 });
    q.enqueueTelemetry(tele("a"));
    q.enqueueTelemetry(tele("b"));
    q.enqueuePayload(payload("p"));
    await q.flush();
    expect(sink.inserts).toHaveLength(2);
    expect(sink.payloadCalls).toHaveLength(1);
    expect(sink.manyCalls).toBe(0); // no batch method available
  });

  it("backpressures telemetry at maxDepth and preserves every row", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (sink.insertMany as ReturnType<typeof vi.fn>).mockImplementation(
      async (inputs: InsertTelemetryInput[]) => {
        await gate;
        sink.inserts.push(...inputs);
      },
    );
    const q = createWriteQueue({
      telemetry: sink,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
      maxDepth: 2,
    });
    await q.enqueueTelemetry(tele("a"));
    await q.enqueueTelemetry(tele("b"));
    let admitted = false;
    const third = q.enqueueTelemetry(tele("c")).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(q.depth).toBe(2);

    release();
    await third;
    await q.flush();
    expect(sink.inserts.map((i) => (i.decision as { request_id: string }).request_id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(logs.some((line) => line.includes("overflow"))).toBe(false);
  });

  it("serializes concurrent admissions so waking producers cannot stampede past maxDepth", async () => {
    const sink = fakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (sink.insertMany as ReturnType<typeof vi.fn>).mockImplementation(
      async (inputs: InsertTelemetryInput[]) => {
        await gate;
        sink.inserts.push(...inputs);
      },
    );
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxDepth: 1,
    });

    await q.enqueueTelemetry(tele("a"));
    const waiting = ["b", "c", "d"].map((id) => q.enqueueTelemetry(tele(id)));
    await Promise.resolve();
    expect(q.depth).toBe(1);

    release();
    await Promise.all(waiting);
    expect(q.depth).toBe(1);
    await q.flush();
    expect(sink.inserts.map((i) => (i.decision as { request_id: string }).request_id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("backpressures payloads on the byte budget and preserves every body", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (sink.insertPayloads as ReturnType<typeof vi.fn>).mockImplementation(
      async (inputs: InsertPayloadInput[]) => {
        await gate;
        sink.payloadCalls.push(...inputs);
      },
    );
    const q = createWriteQueue({
      telemetry: sink,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
      maxDepth: 10_000,
      maxBytes: 1_500,
      flushBytes: 10_000_000,
    });

    await q.enqueuePayload(bigPayload("p1", 600));
    let admitted = false;
    const second = q.enqueuePayload(bigPayload("p2", 600)).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(q.depth).toBe(1);

    release();
    await second;
    await q.flush();
    expect(sink.payloadCalls.map((p) => p.requestId)).toEqual(["p1", "p2"]);
    expect(logs.some((line) => line.includes("overflow"))).toBe(false);
  });

  it("charges retained strings by worst-case V8 bytes instead of UTF-16 code units", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: (message) => logs.push(message),
      flushIntervalMs: 10_000,
      maxBytes: 10,
      flushBytes: 10_000,
    });

    await q.enqueuePayload({
      requestId: "unicode",
      requestJson: "😀😀😀",
      responseJson: null,
      upstreamRequestJson: null,
      createdAt: new Date(0),
    });
    await q.flush();

    expect(sink.payloadCalls.map((input) => input.requestId)).toEqual(["unicode"]);
    expect(logs.some((line) => line.includes("overflow"))).toBe(false);
  });

  it("byte threshold (flushBytes) flushes early before a few rows balloon into a huge txn", async () => {
    // maxBatch=256 rows × 7MB ≈ 1.8GB single commit. flushBytes caps the txn size:
    // a couple of big payloads must flush long before the row threshold.
    const sink = fakeSink();
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxBatch: 256, // row threshold out of reach
      maxBytes: 100_000_000, // budget out of reach
      flushBytes: 1_000, // ~1KB → flush after the first big payload
    });

    await q.enqueuePayload(bigPayload("p1", 1_500)); // exceeds flushBytes alone → eager flush
    // Drain the in-flight threshold flush.
    await q.flush();
    expect(sink.payloadsManyCalls).toBeGreaterThanOrEqual(1);
    expect(sink.payloadCalls.map((p) => p.requestId)).toContain("p1");
  });

  it("runs admitted session writes fail-open on the deferred task chain", async () => {
    const sink = fakeSink();
    const ran: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxBytes: 1_500,
    });
    await q.enqueueSession(async () => {
      ran.push("session");
    }, 100);
    expect(q.depth).toBe(1);
    await q.flush();
    expect(ran).toEqual(["session"]);
    expect(q.depth).toBe(0);
  });

  it("backpressures retained tasks until capacity is free without dropping them", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const q = createWriteQueue({
      telemetry: sink,
      log: (message) => logs.push(message),
      flushIntervalMs: 10_000,
      // The explicit budget keeps this test independent of the host memory limit.
      // 100 wire bytes are charged at the runtime JSON-amplification multiplier.
      maxBytes: 1_000,
    });
    const ran: string[] = [];

    await q.enqueueTask(
      async () => {
        await blocker;
        ran.push("first");
      },
      { retainedBytes: 100 },
    );
    await Promise.resolve(); // let the first task become active
    let admitted = false;
    const second = Promise.resolve(
      q.enqueueTask(
        async () => {
          ran.push("second");
        },
        { retainedBytes: 100 },
      ),
    ).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(q.depth).toBe(1);

    release();
    await second;
    await q.flush();
    expect(ran).toEqual(["first", "second"]);
    expect(logs.some((line) => line.includes("overflow"))).toBe(false);
  });

  it("drains payload capture before admitting a retained side-effect task", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxBytes: 1_500,
      flushBytes: 10_000,
    });
    const ran: string[] = [];
    await q.enqueuePayload(bigPayload("payload", 700));
    await q.enqueueTask(
      async () => {
        ran.push("observe");
      },
      { retainedBytes: 200 },
    );
    await q.flush();
    expect(ran).toEqual(["observe"]);
    expect(sink.payloadCalls.map((input) => input.requestId)).toEqual(["payload"]);
  });

  it("admits one oversized session after draining prior audit telemetry", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    const ran: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: (message) => logs.push(message),
      flushIntervalMs: 10_000,
      maxBytes: 500,
    });
    await q.enqueueTelemetry(tele("audit"));
    await q.enqueueSession(async () => {
      ran.push("session");
    }, 1_000);
    await q.flush();
    expect(ran).toEqual(["session"]);
    expect(sink.inserts).toHaveLength(1);
    expect(logs.some((line) => line.includes("overflow"))).toBe(false);
  });

  it("stop() flushes pending writes and stops the timer", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({ telemetry: sink, log: () => {}, flushIntervalMs: 10_000 });
    q.enqueueTelemetry(tele("a"));
    q.enqueueTask(async () => {});
    await q.stop();
    expect(sink.inserts).toHaveLength(1);
  });

  it("pauses new writes while maintenance drains the existing queue", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: (message) => logs.push(message),
      flushIntervalMs: 10_000,
    });
    q.enqueueTelemetry(tele("before"));

    await q.pauseAndFlush();
    q.enqueueTelemetry(tele("during"));
    q.resume();
    q.enqueueTelemetry(tele("after"));
    await q.flush();

    expect(
      sink.inserts.map((input) => (input.decision as { request_id: string }).request_id),
    ).toEqual(["before", "after"]);
    expect(logs).toContain("writequeue.paused");
  });

  it("persists admissions that started before the maintenance pause barrier", async () => {
    const sink = fakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (sink.insertMany as ReturnType<typeof vi.fn>).mockImplementation(
      async (inputs: InsertTelemetryInput[]) => {
        await gate;
        sink.inserts.push(...inputs);
      },
    );
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxDepth: 1,
    });
    await q.enqueueTelemetry(tele("before"));
    const waiting = [q.enqueueTelemetry(tele("queued-1")), q.enqueueTelemetry(tele("queued-2"))];
    await Promise.resolve();

    const paused = q.pauseAndFlush();
    release();
    await Promise.all([...waiting, paused]);
    q.resume();
    await q.enqueueTelemetry(tele("after"));
    await q.flush();

    expect(
      sink.inserts.map((input) => (input.decision as { request_id: string }).request_id),
    ).toEqual(["before", "queued-1", "queued-2", "after"]);
  });

  it("persists admissions that started before stop", async () => {
    const sink = fakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (sink.insertMany as ReturnType<typeof vi.fn>).mockImplementation(
      async (inputs: InsertTelemetryInput[]) => {
        await gate;
        sink.inserts.push(...inputs);
      },
    );
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxDepth: 1,
    });
    await q.enqueueTelemetry(tele("before"));
    const waiting = [q.enqueueTelemetry(tele("queued-1")), q.enqueueTelemetry(tele("queued-2"))];
    await Promise.resolve();

    const stopped = q.stop();
    release();
    await Promise.all([...waiting, stopped]);

    expect(
      sink.inserts.map((input) => (input.decision as { request_id: string }).request_id),
    ).toEqual(["before", "queued-1", "queued-2"]);
    expect(q.depth).toBe(0);
  });

  it("flush waits for queued admissions and persists them before returning", async () => {
    const sink = fakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (sink.insertMany as ReturnType<typeof vi.fn>).mockImplementation(
      async (inputs: InsertTelemetryInput[]) => {
        await gate;
        sink.inserts.push(...inputs);
      },
    );
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxDepth: 1,
    });
    await q.enqueueTelemetry(tele("a"));
    const waiting = [q.enqueueTelemetry(tele("b")), q.enqueueTelemetry(tele("c"))];
    const flushed = q.flush();
    release();

    await Promise.all([...waiting, flushed]);

    expect(
      sink.inserts.map((input) => (input.decision as { request_id: string }).request_id),
    ).toEqual(["a", "b", "c"]);
    expect(q.depth).toBe(0);
  });

  it("fires onTaskDrain ONLY for tasks flagged wakeOnSettle (inbound observe must not wake)", async () => {
    // onTaskDrain is wired to memoryWorker.wake(). It must fire only after the
    // OUTBOUND observe (wakeOnSettle:true) — waking after the inbound observe could
    // drain the observer job before the assistant turn is persisted, dropping it.
    const sink = fakeSink();
    let drains = 0;
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      onTaskDrain: () => {
        drains++;
      },
    });
    q.enqueueTask(async () => {}); // inbound observe — unflagged, no wake
    q.enqueueTask(async () => {}, { wakeOnSettle: true }); // outbound observe — wakes
    await q.flush();
    expect(drains).toBe(1); // only the flagged (outbound) task woke the worker
  });

  it("is fail-open if onTaskDrain throws: the task chain is not poisoned", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    const ran: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
      onTaskDrain: () => {
        throw new Error("wake boom");
      },
    });
    q.enqueueTask(async () => {
      ran.push("first");
    });
    q.enqueueTask(
      async () => {
        ran.push("second");
      },
      { wakeOnSettle: true },
    );
    await expect(q.flush()).resolves.toBeUndefined();
    expect(ran).toEqual(["first", "second"]); // a throwing wake never stalls observe
    expect(logs.some((l) => l.includes("on_task_drain"))).toBe(true);
  });
});
