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

  it("stop() flushes pending writes and stops the timer", async () => {
    const sink = fakeSink();
    const q = createWriteQueue({ telemetry: sink, log: () => {}, flushIntervalMs: 10_000 });
    q.enqueueTelemetry(tele("a"));
    q.enqueueTask(async () => {});
    await q.stop();
    expect(sink.inserts).toHaveLength(1);
  });

  it("calls onTaskDrain after each task settles (the memory-worker wake trigger)", async () => {
    // The composition root wires onTaskDrain to memoryWorker.wake(): a memory observe
    // settling here is what schedules the debounced drain so a just-stated fact forms
    // in ~coalesceMs instead of waiting a full interval.
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
    q.enqueueTask(async () => {});
    q.enqueueTask(async () => {});
    await q.flush();
    expect(drains).toBe(2); // one per settled task (inbound + outbound observe)
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
    q.enqueueTask(async () => {
      ran.push("second");
    });
    await expect(q.flush()).resolves.toBeUndefined();
    expect(ran).toEqual(["first", "second"]); // a throwing wake never stalls observe
    expect(logs.some((l) => l.includes("on_task_drain"))).toBe(true);
  });
});
