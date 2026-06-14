import { describe, expect, it, vi } from "vitest";
import {
  atEventBoundary,
  type HeartbeatItem,
  type ScheduleTimer,
  withHeartbeat,
} from "./heartbeat.js";

// A manually-fired timer: captures every scheduled callback so a test can release a
// heartbeat at an exact point, with no real time.
function manualTimer(): { schedule: ScheduleTimer; fire: () => void; pending: () => number } {
  let cbs: Array<() => void> = [];
  return {
    schedule: (cb) => {
      cbs.push(cb);
      return () => {
        cbs = cbs.filter((c) => c !== cb);
      };
    },
    fire: () => {
      const batch = cbs;
      cbs = [];
      for (const cb of batch) cb();
    },
    pending: () => cbs.length,
  };
}

// A source whose chunks the test pushes on demand, so idle gaps are explicit.
function gatedSource<T>(): {
  source: AsyncIterable<T>;
  push: (value: T) => void;
  end: () => void;
  fail: (err: unknown) => void;
} {
  let resolve: ((r: IteratorResult<T>) => void) | null = null;
  let reject: ((e: unknown) => void) | null = null;
  const queue: Array<{ ok: true; r: IteratorResult<T> } | { ok: false; e: unknown }> = [];
  const iterator: AsyncIterator<T> = {
    next() {
      const head = queue.shift();
      if (head) return head.ok ? Promise.resolve(head.r) : Promise.reject(head.e);
      return new Promise<IteratorResult<T>>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  };
  return {
    source: { [Symbol.asyncIterator]: () => iterator },
    push: (value) => {
      if (resolve) {
        const r = resolve;
        resolve = null;
        reject = null;
        r({ value, done: false });
      } else queue.push({ ok: true, r: { value, done: false } });
    },
    end: () => {
      if (resolve) {
        const r = resolve;
        resolve = null;
        reject = null;
        r({ value: undefined as never, done: true });
      } else queue.push({ ok: true, r: { value: undefined as never, done: true } });
    },
    fail: (err) => {
      if (reject) {
        const j = reject;
        resolve = null;
        reject = null;
        j(err);
      } else queue.push({ ok: false, e: err });
    },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("atEventBoundary", () => {
  it("is true at the start and after a blank-line terminator", () => {
    expect(atEventBoundary(null)).toBe(true);
    expect(atEventBoundary("data: x\n\n")).toBe(true);
  });
  it("is false mid-frame", () => {
    expect(atEventBoundary('data: {"par')).toBe(false);
    expect(atEventBoundary("event: message\n")).toBe(false);
  });
});

describe("withHeartbeat", () => {
  it("emits a beat when the source idles, then the chunk", async () => {
    const { source, push, end } = gatedSource<string>();
    const timer = manualTimer();
    const gen = withHeartbeat(source, { heartbeatMs: 100, scheduleTimer: timer.schedule });

    const p1 = gen.next();
    await tick(); // let withHeartbeat register the timer + await the race
    expect(timer.pending()).toBe(1);
    timer.fire();
    expect(await p1).toEqual<IteratorResult<HeartbeatItem<string>>>({
      done: false,
      value: { type: "beat" },
    });

    const p2 = gen.next();
    push("data: x\n\n");
    expect(await p2).toEqual({ done: false, value: { type: "chunk", value: "data: x\n\n" } });

    const p3 = gen.next();
    end();
    expect((await p3).done).toBe(true);
  });

  it("does not beat when chunks flow faster than the cadence", async () => {
    const { source, push, end } = gatedSource<string>();
    const timer = manualTimer();
    const out: HeartbeatItem<string>[] = [];
    push("a");
    push("b");
    end();
    for await (const item of withHeartbeat(source, {
      heartbeatMs: 100,
      scheduleTimer: timer.schedule,
    })) {
      out.push(item);
    }
    expect(out).toEqual([
      { type: "chunk", value: "a" },
      { type: "chunk", value: "b" },
    ]);
  });

  it("passes chunks straight through when disabled (heartbeatMs=0)", async () => {
    const { source, push, end } = gatedSource<string>();
    const schedule = vi.fn<ScheduleTimer>(() => () => {});
    const out: HeartbeatItem<string>[] = [];
    push("a");
    end();
    for await (const item of withHeartbeat(source, { heartbeatMs: 0, scheduleTimer: schedule })) {
      out.push(item);
    }
    expect(out).toEqual([{ type: "chunk", value: "a" }]);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("propagates a source error", async () => {
    const { source, fail } = gatedSource<string>();
    const timer = manualTimer();
    const gen = withHeartbeat(source, { heartbeatMs: 100, scheduleTimer: timer.schedule });
    const p = gen.next();
    await tick();
    fail(new Error("upstream boom"));
    await expect(p).rejects.toThrow("upstream boom");
  });

  it("returns the source and leaves no timer pending when the consumer breaks", async () => {
    const { source, push } = gatedSource<string>();
    const iterator = source[Symbol.asyncIterator]();
    const returnSpy = vi.spyOn(iterator, "return");
    const timer = manualTimer();
    push("a");
    for await (const item of withHeartbeat(source, {
      heartbeatMs: 100,
      scheduleTimer: timer.schedule,
    })) {
      expect(item).toEqual({ type: "chunk", value: "a" });
      break; // consumer stops after the first chunk (for-await calls return())
    }
    expect(returnSpy).toHaveBeenCalled();
    expect(timer.pending()).toBe(0);
  });
});
