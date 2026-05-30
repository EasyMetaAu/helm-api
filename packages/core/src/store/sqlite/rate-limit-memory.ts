import { type BucketState, tryConsume } from "../../ratelimit/token-bucket.js";
import type { RateLimitConsumeResult, RateLimitStore } from "../ports.js";

// Process-memory RateLimitStore. Single-process default (and the second adapter
// in the port-contract test). State lives on the instance, so rebuilding the
// limiter over the SAME store continues the window — but a process restart
// resets it (use the sqlite adapter for multi-instance / restart durability).
// `consume` is synchronous under JS's single-threaded model: refill + debit
// happen without interleaving, so two requests cannot both spend the last token.
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();

  async consume(
    keyId: string,
    dim: "rpm" | "tpm",
    _state: BucketState | null,
    capacityPerMin: number,
    cost: number,
    nowMs: number,
  ): Promise<RateLimitConsumeResult> {
    const id = `${keyId}:${dim}`;
    const current = this.buckets.get(id) ?? { tokens: capacityPerMin, lastRefillMs: nowMs };
    const result = tryConsume(current, capacityPerMin, cost, nowMs);
    this.buckets.set(id, result.state);
    return result;
  }
}
