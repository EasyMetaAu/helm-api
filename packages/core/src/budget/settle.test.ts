import { describe, expect, it, vi } from "vitest";
import type { BudgetStore } from "../store/ports.js";
import { settleBudget } from "./settle.js";
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

function debitStore(): { store: Pick<BudgetStore, "debit">; debit: ReturnType<typeof vi.fn> } {
  const debit = vi.fn(async () => ({ remaining: 0 }));
  return { store: { debit }, debit };
}

describe("settleBudget", () => {
  it("debits each active dimension with the actual served usage", async () => {
    const { store, debit } = debitStore();
    await settleBudget(
      { store, config: CONFIG },
      "k1",
      caps({ requests: 1000, tokens: 500_000, spendUsd: 10, windowSeconds: 3600 }),
      { requests: 1, tokens: 1234, costUsd: 0.42 },
      0,
    );
    const windowMs = 3600 * 1000;
    expect(debit).toHaveBeenCalledWith("k1", "req", 1000, windowMs, 1, 0);
    expect(debit).toHaveBeenCalledWith("k1", "tok", 500_000, windowMs, 1234, 0);
    expect(debit).toHaveBeenCalledWith("k1", "usd", 10, windowMs, 0.42, 0);
  });

  it("only touches capped dimensions (uncapped key => no debit)", async () => {
    const { store, debit } = debitStore();
    await settleBudget(
      { store, config: CONFIG },
      "k1",
      caps({ spendUsd: 10 }),
      { requests: 1, tokens: 999, costUsd: 0.1 },
      0,
    );
    expect(debit).toHaveBeenCalledTimes(1);
    expect(debit).toHaveBeenCalledWith("k1", "usd", 10, 86_400_000, 0.1, 0);
  });

  it("null cost (not measured) settles 0 for spend — never recomputed, never blocks", async () => {
    const { store, debit } = debitStore();
    await settleBudget(
      { store, config: CONFIG },
      "k1",
      caps({ spendUsd: 10 }),
      { requests: 1, tokens: 0, costUsd: null },
      0,
    );
    expect(debit).toHaveBeenCalledWith("k1", "usd", 10, 86_400_000, 0, 0);
  });

  it("no caps => no-op (no store calls)", async () => {
    const { store, debit } = debitStore();
    await settleBudget(
      { store, config: CONFIG },
      "k1",
      caps(),
      { requests: 1, tokens: 5, costUsd: 1 },
      0,
    );
    expect(debit).not.toHaveBeenCalled();
  });
});
