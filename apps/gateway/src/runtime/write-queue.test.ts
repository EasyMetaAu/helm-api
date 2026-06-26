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

  it("bounds depth: drops + logs under overflow, never throws", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
      maxDepth: 2,
    });
    expect(() => {
      q.enqueueTelemetry(tele("a"));
      q.enqueueTelemetry(tele("b"));
      q.enqueueTelemetry(tele("c")); // over depth → drop, log
      q.enqueueTelemetry(tele("d"));
    }).not.toThrow();
    await q.flush();
    expect(sink.inserts.length).toBeLessThanOrEqual(2);
    expect(logs.some((l) => l.includes("overflow"))).toBe(true);
  });

  it("drops new buffered writes when pending tasks already fill maxDepth", async () => {
    const sink = fakeSink();
    const logs: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const q = createWriteQueue({
      telemetry: sink,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
      maxDepth: 1,
    });

    q.enqueueTask(async () => {
      await blocker;
    });
    q.enqueueTelemetry(tele("dropped-telemetry"));
    q.enqueuePayload(payload("dropped-payload"));

    release();
    await q.flush();

    expect(sink.inserts).toHaveLength(0);
    expect(sink.payloadCalls).toHaveLength(0);
    expect(logs.filter((l) => l.includes("overflow"))).toHaveLength(2);
  });

  it("sheds on the BYTE budget even when row depth is nowhere near maxDepth", async () => {
    // Production payloads are 6-7MB each. A handful of them blows the heap long
    // before the 10k-row maxDepth. The byte budget must trip on size, not count.
    const sink = fakeSink();
    const logs: string[] = [];
    const q = createWriteQueue({
      telemetry: sink,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
      maxDepth: 10_000, // far out of reach
      maxBytes: 1_000, // ~1KB budget: two 600B payloads must not both fit
      flushBytes: 10_000_000, // park eager byte-flush so we observe shedding, not flushing
    });

    q.enqueuePayload(bigPayload("p1", 600));
    q.enqueuePayload(bigPayload("p2", 600)); // total would be 1200B > 1000 → shed oldest

    await q.flush();
    // Only the newest fits under budget; the older one was shed (not a row-count drop).
    expect(sink.payloadCalls.map((p) => p.requestId)).toEqual(["p2"]);
    expect(logs.some((l) => l.includes("overflow"))).toBe(true);
  });

  it("on byte overflow, sheds PAYLOAD (debug) first and keeps TELEMETRY (audit)", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxDepth: 10_000,
      maxBytes: 1_000,
      flushBytes: 10_000_000,
    });

    q.enqueueTelemetry(tele("audit")); // cheap, must survive
    q.enqueuePayload(bigPayload("debug-1", 600));
    q.enqueuePayload(bigPayload("debug-2", 600)); // overflow → drop a payload, not the telemetry

    await q.flush();
    // Telemetry (audit) is preserved; a payload (debug料) was the one shed.
    expect(sink.inserts.map((i) => (i.decision as { request_id: string }).request_id)).toEqual([
      "audit",
    ]);
    expect(sink.payloadCalls.map((p) => p.requestId)).toEqual(["debug-2"]);
  });

  it("keeps the byte count accurate across push/shed: a stream of big payloads stays bounded", async () => {
    // If the byte accounting under-counted on shed, the buffer would creep up and
    // eventually exceed the budget without ever flushing — the OOM we're fixing.
    const sink = fakeSink();
    const q = createWriteQueue({
      telemetry: sink,
      log: () => {},
      flushIntervalMs: 10_000,
      maxDepth: 10_000,
      maxBytes: 1_000,
      flushBytes: 10_000_000, // never byte-flush; force the budget to hold via shedding alone
    });

    // 50 payloads of ~600B each: only ~one fits at a time under a 1KB budget.
    for (let i = 0; i < 50; i++) q.enqueuePayload(bigPayload(`p${i}`, 600));

    // depth never ran away (a single 600B row + headroom; certainly not 50).
    expect(q.depth).toBeLessThanOrEqual(2);
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

    q.enqueuePayload(bigPayload("p1", 1_500)); // exceeds flushBytes alone → eager flush
    // Drain the in-flight threshold flush.
    await q.flush();
    expect(sink.payloadsManyCalls).toBeGreaterThanOrEqual(1);
    expect(sink.payloadCalls.map((p) => p.requestId)).toContain("p1");
  });

  it("counts IN-FLIGHT batches toward the byte budget so a stalled writer can't pile up unbounded memory", async () => {
    // The OOM scenario this whole change exists to fix: the DB writer is blocked (4am
    // VACUUM holds the write lock). doFlush hands batches to the write chain, but they
    // still occupy the heap until the commit lands. Counting only the live buffer would
    // let repeated flushBytes triggers queue unbounded 6-7MB batches behind the first
    // blocked write. In-flight bytes must count toward maxBytes so admit() rejects once
    // the cap is reached — otherwise the byte budget doesn't actually bound the heap.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const received: string[] = [];
    const stalled: WriteQueueTelemetry = {
      insert: async () => ({ id: "x" }),
      insertMany: async () => {},
      insertPayload: async (i) => {
        received.push(i.requestId);
      },
      insertPayloads: async (xs) => {
        received.push(...xs.map((x) => x.requestId));
        await gate; // writer is stalled until released
      },
    };
    const logs: string[] = [];
    const q = createWriteQueue({
      telemetry: stalled,
      log: (m) => logs.push(m),
      flushIntervalMs: 10_000,
      maxDepth: 10_000, // row backstop far out of reach — only bytes can gate
      maxBytes: 2_000,
      flushBytes: 500, // eager-flush each big payload into the (stalled) chain
    });

    // 100 × 600B payloads at a stalled writer. With in-flight accounting the budget
    // trips and most are rejected; without it every one would flush and the heap balloon.
    for (let i = 0; i < 100; i++) q.enqueuePayload(bigPayload(`p${i}`, 600));
    expect(logs.filter((l) => l.includes("overflow")).length).toBeGreaterThan(0);

    release();
    await q.flush();
    // Only a bounded prefix (~maxBytes worth) ever reached the writer — not all 100.
    expect(received.length).toBeLessThanOrEqual(5);
  });

  it("stop() flushes pending writes and stops the timer", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({ telemetry: sink, log: () => {}, flushIntervalMs: 10_000 });
    q.enqueueTelemetry(tele("a"));
    q.enqueueTask(async () => {});
    await q.stop();
    expect(sink.inserts).toHaveLength(1);
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
