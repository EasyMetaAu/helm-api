// Rate limiter types. Config types (RateLimitConfig / quota / override) are owned
// by @helm/shared (Zod is the single source of truth, principle 2) and re-exported
// here so the limiter has one import surface. The probe/result types are pure
// runtime DTOs — no web framework, no DB (principle 1).
import type { RateLimitConfig, RateLimitQuota, RateLimitQuotaOverride } from "@helm/shared";

export type { RateLimitConfig, RateLimitQuota, RateLimitQuotaOverride };

// One rate-limit decision input: the Auth-resolved key_id, a pre-classification
// token estimate (TPM pre-debit), and an injected clock (ms) for testability.
// `override` carries the key's OWN per-key quota (from the ApiKeyRecord, surfaced
// by Auth) so the limiter need not read the KeyStore: a present dimension wins
// over config.overrides[keyId] and over config.default; an absent dimension falls
// through to those. null/undefined dimensions inherit (see resolveQuota).
export interface RateLimitProbe {
  keyId: string;
  estimatedTokens: number;
  now: number;
  override?: { rpm?: number | null; tpm?: number | null };
}

// One rate-limit decision output. `limit/remaining/resetSeconds` describe the
// TIGHTER of the two dimensions (what the client should pay attention to) so the
// gateway can emit a single set of x-ratelimit-* headers.
export interface RateLimitResult {
  allowed: boolean;
  limitedBy: "rpm" | "tpm" | null;
  limit: number; // x-ratelimit-limit
  remaining: number; // x-ratelimit-remaining (floored)
  resetSeconds: number; // x-ratelimit-reset
  retryAfterSeconds: number; // meaningful only when !allowed
}
