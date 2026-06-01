import type { OverQuotaBehavior } from "@helm/shared";

export type { OverQuotaBehavior };

// Live, re-bindable credit-gate config (mirrors RateLimitConfig). The gate reads
// `enabled` / `defaultQuotaUsd` / `overQuotaBehavior` FRESH on every check() so the
// admin can flip them at runtime without a restart (server.ts onSettings re-binds
// this object in place). 0 default quota = unlimited (mirrors the rate-limit 0).
export interface CreditConfig {
  enabled: boolean;
  defaultQuotaUsd: number;
  overQuotaBehavior: OverQuotaBehavior;
}

// One credit-gate decision input. `accountId` is the Auth-resolved account (null
// when no identity resolved — nothing to meter). `quota` optionally carries the
// account's OWN tri-state quota override (null = inherit the system default; 0 =
// unlimited; a number = the hard cap), mirroring RateLimitProbe.override. When
// omitted, the gate inherits config.defaultQuotaUsd.
export interface CreditProbe {
  accountId: string | null;
  quota?: number | null;
}

// One credit-gate decision output. `limitedBy` is "credit" when rejected (the
// single dimension), else null. `alert` is true only in alert mode when the
// account is over quota (served but flagged). balance/quota describe the resolved
// effective values (null when the fast path skipped the store read).
export interface CreditCheckResult {
  allowed: boolean;
  limitedBy: "credit" | null;
  alert: boolean;
  balance: number | null;
  quota: number | null;
}
