import type { DecisionRecord } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { CreditMovementInput, CreditStore } from "../store/ports.js";
import { debitForDecision } from "./ledger.js";

function decision(totalUsd: number | null): DecisionRecord {
  return {
    request_id: "req_1",
    cost_breakdown: { eval_usd: null, completion_usd: totalUsd, total_usd: totalUsd },
  } as unknown as DecisionRecord;
}

function debitSpy() {
  const calls: CreditMovementInput[] = [];
  const debit = vi.fn(async (input: CreditMovementInput) => {
    calls.push(input);
    return { balanceAfter: -input.amountUsd, ok: true };
  });
  const store = { debit } as unknown as CreditStore;
  return { store, debit, calls };
}

const NOW = 1_700_000_000_000;

describe("debitForDecision", () => {
  it("debits the EXACT total_usd from telemetry (never recomputed, D6)", async () => {
    const { store, calls } = debitSpy();
    await debitForDecision(store, {
      decision: decision(0.0731),
      accountId: "a",
      apiKeyId: "k1",
      nowMs: NOW,
    });
    expect(calls).toHaveLength(1);
    // Signed negative — a debit lowers the balance by exactly total_usd.
    expect(calls[0]?.amountUsd).toBeCloseTo(-0.0731);
    expect(calls[0]?.kind).toBe("debit");
    expect(calls[0]?.costMeasured).toBe(true);
    expect(calls[0]?.accountId).toBe("a");
    expect(calls[0]?.apiKeyId).toBe("k1"); // key_id only (principle 7)
    expect(calls[0]?.requestId).toBe("req_1");
  });

  it("null total_usd → debits 0 + cost_measured=false (D4 — never blocks)", async () => {
    const { store, calls } = debitSpy();
    await debitForDecision(store, {
      decision: decision(null),
      accountId: "a",
      apiKeyId: "k1",
      nowMs: NOW,
    });
    expect(calls[0]?.amountUsd).toBe(0);
    expect(calls[0]?.costMeasured).toBe(false);
  });

  it("a measured 0 cost debits 0 + cost_measured=true (distinct from null)", async () => {
    const { store, calls } = debitSpy();
    await debitForDecision(store, {
      decision: decision(0),
      accountId: "a",
      apiKeyId: "k1",
      nowMs: NOW,
    });
    expect(calls[0]?.amountUsd).toBe(0);
    expect(calls[0]?.costMeasured).toBe(true);
  });

  it("returns the balanceAfter from the store", async () => {
    const { store } = debitSpy();
    const r = await debitForDecision(store, {
      decision: decision(0.5),
      accountId: "a",
      apiKeyId: "k1",
      nowMs: NOW,
    });
    expect(r?.balanceAfter).toBeCloseTo(0.5);
  });
});
