import { describe, expect, it, vi } from "vitest";
import type { AccountBalance, CreditStore } from "../store/ports.js";
import { createCreditGate } from "./gate.js";

// A CreditStore stub exposing only getBalance (the gate reads balance ONLY — the
// debit happens post-served, not here). Records whether getBalance was called so
// the "fast path never touches the store" invariant can be asserted.
function stubStore(balance: AccountBalance | null | Error): {
  store: CreditStore;
  getBalance: ReturnType<typeof vi.fn>;
} {
  const getBalance = vi.fn(async () => {
    if (balance instanceof Error) throw balance;
    return balance;
  });
  const notImpl = () => {
    throw new Error("not implemented in stub");
  };
  const store = {
    getBalance,
    debit: notImpl,
    topup: notImpl,
    ensureAccount: notImpl,
    listAccounts: notImpl,
    spendByAccount: notImpl,
    recentLedger: notImpl,
  } as unknown as CreditStore;
  return { store, getBalance };
}

const cfg = (
  over: Partial<{ enabled: boolean; defaultQuotaUsd: number; behavior: "reject" | "alert" }> = {},
) => ({
  enabled: over.enabled ?? true,
  defaultQuotaUsd: over.defaultQuotaUsd ?? 10,
  overQuotaBehavior: over.behavior ?? ("reject" as const),
});

describe("createCreditGate", () => {
  it("credits disabled → always allowed, store NEVER read (zero-touch)", async () => {
    const { store, getBalance } = stubStore({ balance: -100, quota: 5, disabled: false });
    const gate = createCreditGate({ store, config: cfg({ enabled: false }) });
    const r = await gate.check({ accountId: "a" });
    expect(r.allowed).toBe(true);
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("account quota 0 (unlimited) wins over a finite default", async () => {
    const { store, getBalance } = stubStore({ balance: -100, quota: 0, disabled: false });
    const gate = createCreditGate({ store, config: cfg({ defaultQuotaUsd: 50 }) });
    const r = await gate.check({ accountId: "a" });
    expect(r.allowed).toBe(true);
    expect(getBalance).toHaveBeenCalledOnce();
  });

  it("default quota 0 with no account override → allowed after reading the account row", async () => {
    const { store, getBalance } = stubStore({ balance: -100, quota: null, disabled: false });
    const gate = createCreditGate({ store, config: cfg({ defaultQuotaUsd: 0 }) });
    const r = await gate.check({ accountId: "a" });
    expect(r.allowed).toBe(true);
    expect(getBalance).toHaveBeenCalledOnce();
  });

  it("account finite quota wins over default quota 0", async () => {
    const { store, getBalance } = stubStore({ balance: 0, quota: 25, disabled: false });
    const gate = createCreditGate({ store, config: cfg({ defaultQuotaUsd: 0 }) });
    const r = await gate.check({ accountId: "a" });
    expect(r.allowed).toBe(false);
    expect(r.quota).toBe(25);
    expect(getBalance).toHaveBeenCalledOnce();
  });

  it("positive balance under a finite quota → allowed", async () => {
    const { store } = stubStore({ balance: 3.5, quota: 10, disabled: false });
    const gate = createCreditGate({ store, config: cfg() });
    const r = await gate.check({ accountId: "a" });
    expect(r.allowed).toBe(true);
    expect(r.balance).toBeCloseTo(3.5);
  });

  it("null per-account quota → inherits the system default quota", async () => {
    // quota null on the row → falls back to config.defaultQuotaUsd (10). Balance
    // positive → allowed; the gate must have consulted the default (non-zero) and
    // therefore read the store (not the unlimited fast path).
    const { store, getBalance } = stubStore({ balance: 1, quota: null, disabled: false });
    const gate = createCreditGate({ store, config: cfg({ defaultQuotaUsd: 10 }) });
    const r = await gate.check({ accountId: "a" });
    expect(r.allowed).toBe(true);
    expect(getBalance).toHaveBeenCalledOnce();
  });

  it("balance <= 0 with a finite quota and reject behavior → NOT allowed", async () => {
    const { store } = stubStore({ balance: 0, quota: 10, disabled: false });
    const gate = createCreditGate({ store, config: cfg({ behavior: "reject" }) });
    const r = await gate.check({ accountId: "a" });
    expect(r.allowed).toBe(false);
    expect(r.limitedBy).toBe("credit");
    expect(r.alert).toBe(false);
  });

  it("balance <= 0 is a pure SIGN check — no cost pre-estimate (D5)", async () => {
    // Balance exactly 0 is allowed-to-serve? No: 0 is not > 0, so over quota.
    // A tiny positive balance is allowed even though the request may cost more.
    const { store } = stubStore({ balance: 0.0001, quota: 10, disabled: false });
    const gate = createCreditGate({ store, config: cfg() });
    expect((await gate.check({ accountId: "a" })).allowed).toBe(true);
  });

  it("over quota + alert behavior → ALLOWED but flagged (soft)", async () => {
    const { store } = stubStore({ balance: -2, quota: 10, disabled: false });
    const gate = createCreditGate({ store, config: cfg({ behavior: "alert" }) });
    const r = await gate.check({ accountId: "a" });
    expect(r.allowed).toBe(true);
    expect(r.alert).toBe(true);
  });

  it("disabled account → NOT allowed regardless of balance (reject)", async () => {
    const { store } = stubStore({ balance: 100, quota: 10, disabled: true });
    const gate = createCreditGate({ store, config: cfg() });
    expect((await gate.check({ accountId: "a" })).allowed).toBe(false);
  });

  it("missing account row (null) → treated as zero balance under default quota → rejected", async () => {
    const { store } = stubStore(null);
    const gate = createCreditGate({ store, config: cfg({ defaultQuotaUsd: 10 }) });
    expect((await gate.check({ accountId: "a" })).allowed).toBe(false);
  });

  it("store error PROPAGATES (fail-CLOSED) — never silently allowed", async () => {
    const { store } = stubStore(new Error("db down"));
    const gate = createCreditGate({ store, config: cfg() });
    await expect(gate.check({ accountId: "a" })).rejects.toThrow(/db down/);
  });

  it("no accountId on the probe → allowed, store not read (nothing to meter)", async () => {
    const { store, getBalance } = stubStore(null);
    const gate = createCreditGate({ store, config: cfg() });
    const r = await gate.check({ accountId: null });
    expect(r.allowed).toBe(true);
    expect(getBalance).not.toHaveBeenCalled();
  });
});
