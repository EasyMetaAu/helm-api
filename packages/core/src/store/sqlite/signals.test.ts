import type { RoutingSignal } from "@helm/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { SignalStore } from "../ports.js";
import { createSqliteDb, type SqliteDb } from "./migrate.js";
import { SqliteSignalStore } from "./signals.js";
import { InMemorySignalStore } from "./signals-memory.js";

function makeSignal(over: Partial<RoutingSignal> = {}): RoutingSignal {
  return {
    taskType: "chat",
    lane: "balanced",
    windowStart: 1_000,
    windowEnd: 2_000,
    samples: 3,
    successRate: 0.66,
    fallbackRate: 0.1,
    classifierFallbackRate: 0.2,
    errorRate: 0.34,
    p50LatencyMs: 120,
    p95LatencyMs: 300,
    avgCostUsd: 0.0021,
    updatedAt: 5_000,
    ...over,
  };
}

// One contract, two adapters (sqlite default + in-memory). The supabase adapter
// will join the same describe.each when the supabase port set lands — see
// implementation-notes (mirrors the rate-limit precedent).
const adapters: Array<{ name: string; make: () => { store: SignalStore; close: () => void } }> = [
  {
    name: "sqlite",
    make: () => {
      const db: SqliteDb = createSqliteDb(":memory:");
      return { store: new SqliteSignalStore(db), close: () => db.$sqlite.close() };
    },
  },
  {
    name: "in-memory",
    make: () => ({ store: new InMemorySignalStore(), close: () => {} }),
  },
];

describe.each(adapters)("SignalStore contract — $name", ({ make }) => {
  let ctx: { store: SignalStore; close: () => void };
  afterEach(() => ctx?.close());

  it("upsert then getSignal round-trips the full shape", async () => {
    ctx = make();
    const sig = makeSignal();
    await ctx.store.upsertSignals([sig]);
    const got = await ctx.store.getSignal("chat", "balanced");
    expect(got).toEqual(sig);
  });

  it("getSignal returns null for an unknown (taskType, lane)", async () => {
    ctx = make();
    expect(await ctx.store.getSignal("nope", "nope")).toBeNull();
  });

  it("upsert overwrites the existing (taskType, lane) signal — never duplicates", async () => {
    ctx = make();
    await ctx.store.upsertSignals([makeSignal({ samples: 3, updatedAt: 1 })]);
    await ctx.store.upsertSignals([makeSignal({ samples: 9, updatedAt: 2 })]);
    const got = await ctx.store.getSignal("chat", "balanced");
    expect(got?.samples).toBe(9);
    expect(got?.updatedAt).toBe(2);
  });

  it("keeps distinct (taskType, lane) rows independent", async () => {
    ctx = make();
    await ctx.store.upsertSignals([
      makeSignal({ taskType: "chat", lane: "balanced", samples: 1 }),
      makeSignal({ taskType: "code", lane: "premium", samples: 2 }),
    ]);
    expect((await ctx.store.getSignal("chat", "balanced"))?.samples).toBe(1);
    expect((await ctx.store.getSignal("code", "premium"))?.samples).toBe(2);
  });

  it("preserves a null avgCostUsd through the round-trip", async () => {
    ctx = make();
    await ctx.store.upsertSignals([makeSignal({ avgCostUsd: null })]);
    expect((await ctx.store.getSignal("chat", "balanced"))?.avgCostUsd).toBeNull();
  });
});
