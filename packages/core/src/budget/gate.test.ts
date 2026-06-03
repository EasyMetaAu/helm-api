import { describe, expect, it, vi } from "vitest";
import type { BudgetDim, BudgetPeekResult, BudgetStore } from "../store/ports.js";
import { createBudgetGate } from "./gate.js";
import type { BudgetCaps, BudgetConfig } from "./types.js";

const CONFIG: BudgetConfig = { defaultWindowSeconds: 86_400, defaultDegradeLane: "economy" };

function caps(over: Partial<BudgetCaps> = {}): BudgetCaps {
  return {
    requests: null,
    tokens: null,
    spendUsd: null,
    windowSeconds: null,
    behavior: "degrade",
    degradeLane: null,
    ...over,
  };
}

// A peek stub keyed by dim → remaining. ok = remaining > 0.
function peekStore(remainingByDim: Partial<Record<BudgetDim, number>>): {
  store: Pick<BudgetStore, "peek">;
  peek: ReturnType<typeof vi.fn>;
} {
  const peek = vi.fn(
    async (_keyId: string, dim: BudgetDim, capacity: number): Promise<BudgetPeekResult> => {
      const remaining = remainingByDim[dim] ?? capacity;
      return { remaining, ok: remaining > 0 };
    },
  );
  return { store: { peek }, peek };
}

describe("createBudgetGate", () => {
  it("zero-touch fast path: no caps => within budget, store never read", async () => {
    const { store, peek } = peekStore({});
    const gate = createBudgetGate({ store, config: CONFIG });
    const r = await gate.check({ keyId: "k1", caps: caps(), nowMs: 0 });
    expect(r.overBudget).toBe(false);
    expect(peek).not.toHaveBeenCalled();
  });

  it("defensively treats a 0/negative cap as no-cap (no store read; schema rejects 0)", async () => {
    const { store, peek } = peekStore({});
    const gate = createBudgetGate({ store, config: CONFIG });
    const r = await gate.check({ keyId: "k1", caps: caps({ spendUsd: 0 }), nowMs: 0 });
    expect(r.overBudget).toBe(false);
    expect(peek).not.toHaveBeenCalled();
  });

  it("within budget when every active dimension has remaining > 0", async () => {
    const { store } = peekStore({ usd: 5, req: 100 });
    const gate = createBudgetGate({ store, config: CONFIG });
    const r = await gate.check({
      keyId: "k1",
      caps: caps({ spendUsd: 10, requests: 1000 }),
      nowMs: 0,
    });
    expect(r.overBudget).toBe(false);
    expect(r.limitedBy).toBeNull();
  });

  it("over budget => degrade to the resolved lane (key lane, else default economy)", async () => {
    const { store } = peekStore({ usd: 0 });
    const gate = createBudgetGate({ store, config: CONFIG });
    const r = await gate.check({ keyId: "k1", caps: caps({ spendUsd: 10 }), nowMs: 0 });
    expect(r.overBudget).toBe(true);
    expect(r.limitedBy).toBe("usd");
    expect(r.behavior).toBe("degrade");
    expect(r.degradeLane).toBe("economy");
  });

  it("uses the per-key degrade lane when set", async () => {
    const { store } = peekStore({ usd: -1 });
    const gate = createBudgetGate({ store, config: CONFIG });
    const r = await gate.check({
      keyId: "k1",
      caps: caps({ spendUsd: 10, degradeLane: "balanced" }),
      nowMs: 0,
    });
    expect(r.degradeLane).toBe("balanced");
  });

  it("over budget with reject behavior surfaces reject", async () => {
    const { store } = peekStore({ tok: 0 });
    const gate = createBudgetGate({ store, config: CONFIG });
    const r = await gate.check({
      keyId: "k1",
      caps: caps({ tokens: 500, behavior: "reject" }),
      nowMs: 0,
    });
    expect(r.overBudget).toBe(true);
    expect(r.behavior).toBe("reject");
  });

  it("FAIL-CLOSED: a peek store error propagates (never a silent pass)", async () => {
    const store: Pick<BudgetStore, "peek"> = {
      peek: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const gate = createBudgetGate({ store, config: CONFIG });
    await expect(
      gate.check({ keyId: "k1", caps: caps({ spendUsd: 10 }), nowMs: 0 }),
    ).rejects.toThrow("db down");
  });
});
