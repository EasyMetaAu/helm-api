import { describe, expect, it } from "vitest";
import { deriveRuntimeMemoryBudget } from "./memory-budget.js";

describe("deriveRuntimeMemoryBudget", () => {
  it("scales every in-memory budget from the detected runtime capacity", () => {
    const small = deriveRuntimeMemoryBudget({
      heapLimitBytes: 1_000,
      constrainedMemoryBytes: 2_000,
      rssBytes: 500,
      heapTotalBytes: 400,
    });
    const large = deriveRuntimeMemoryBudget({
      heapLimitBytes: 2_000,
      constrainedMemoryBytes: 4_000,
      rssBytes: 1_000,
      heapTotalBytes: 800,
    });

    expect(large.activeRequestBytes).toBe(small.activeRequestBytes * 2);
    expect(large.responseWorkBytes).toBe(small.responseWorkBytes * 2);
    expect(large.maxWireBytes).toBe(small.maxWireBytes * 2);
    expect(
      Math.abs(large.minRequestChargeBytes - small.minRequestChargeBytes * 2),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(large.writeQueueBytes - small.writeQueueBytes * 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(large.sessionCacheBytes - small.sessionCacheBytes * 2)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(large.responseCaptureBytes - small.responseCaptureBytes * 2),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(large.sseTailChars - small.sseTailChars * 2)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(large.sqlitePageCacheBytes - small.sqlitePageCacheBytes * 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(large.sqliteMaintenanceCacheBytes - small.sqliteMaintenanceCacheBytes * 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(large.websocketIngressBytes - small.websocketIngressBytes * 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(large.websocketMaxPayloadBytes - small.websocketMaxPayloadBytes * 2),
    ).toBeLessThanOrEqual(1);
  });

  it("uses rss plus available memory as the process limit without cgroup constraints", () => {
    const budget = deriveRuntimeMemoryBudget({
      heapLimitBytes: 1_000,
      constrainedMemoryBytes: 0,
      rssBytes: 400,
      heapTotalBytes: 300,
      availableMemoryBytes: 1_600,
    });

    expect(budget.processLimitBytes).toBe(2_000);
    expect(budget.websocketIngressBytes).toBeGreaterThan(0);
    expect(budget.websocketMaxPayloadBytes).toBeGreaterThan(0);
  });

  it("ignores the no-limit sentinel returned by process.constrainedMemory", () => {
    const budget = deriveRuntimeMemoryBudget({
      heapLimitBytes: 1_000,
      constrainedMemoryBytes: Number.MAX_SAFE_INTEGER + 1,
      rssBytes: 400,
      heapTotalBytes: 300,
      availableMemoryBytes: 1_600,
    });

    expect(budget.processLimitBytes).toBe(2_000);
  });

  it("reduces websocket ingress capacity as non-heap RSS grows", () => {
    const quiet = deriveRuntimeMemoryBudget({
      heapLimitBytes: 1_000,
      constrainedMemoryBytes: 2_000,
      rssBytes: 400,
      heapTotalBytes: 300,
    });
    const busy = deriveRuntimeMemoryBudget({
      heapLimitBytes: 1_000,
      constrainedMemoryBytes: 2_000,
      rssBytes: 700,
      heapTotalBytes: 300,
    });

    expect(busy.websocketIngressBytes).toBeLessThan(quiet.websocketIngressBytes);
  });

  it("shrinks websocket max payload to native headroom and fails closed only at zero", () => {
    const narrow = deriveRuntimeMemoryBudget({
      heapLimitBytes: 1_000,
      constrainedMemoryBytes: 1_050,
      rssBytes: 200,
      heapTotalBytes: 200,
    });
    const none = deriveRuntimeMemoryBudget({
      heapLimitBytes: 1_000,
      constrainedMemoryBytes: 1_000,
      rssBytes: 200,
      heapTotalBytes: 200,
    });

    expect(narrow.websocketIngressBytes).toBeGreaterThan(0);
    expect(narrow.websocketMaxPayloadBytes).toBe(narrow.websocketIngressBytes);
    expect(narrow.websocketMaxPayloadBytes).toBeLessThan(narrow.maxWireBytes);
    expect(none.websocketIngressBytes).toBe(0);
    expect(none.websocketMaxPayloadBytes).toBe(0);
  });

  it("uses the tighter process capacity for every runtime allocation", () => {
    const budget = deriveRuntimeMemoryBudget({
      heapLimitBytes: 1024 * 1024 * 1024,
      constrainedMemoryBytes: 512 * 1024 * 1024,
    });

    expect(budget.processLimitBytes).toBe(512 * 1024 * 1024);
    expect(budget.activeRequestBytes).toBe(Math.floor(budget.processLimitBytes * 0.2));
    expect(budget.responseWorkBytes).toBe(Math.floor(budget.processLimitBytes * 0.2));
    expect(budget.minRequestChargeBytes).toBe(Math.floor(budget.activeRequestBytes * 0.01));
    expect(budget.writeQueueBytes).toBe(Math.floor(budget.processLimitBytes * 0.08));
    expect(budget.sessionCacheBytes).toBe(Math.floor(budget.processLimitBytes * 0.04));
    expect(budget.responseCaptureBytes).toBe(Math.floor(budget.processLimitBytes * 0.06));
    expect(budget.sseTailChars).toBe(Math.floor(budget.responseCaptureBytes * 0.0004));
    expect(budget.sqlitePageCacheBytes).toBe(Math.floor(budget.processLimitBytes * 0.03));
  });

  it("admits the production-proven request at the observed constrained heap capacity", () => {
    const budget = deriveRuntimeMemoryBudget({
      heapLimitBytes: 706_740_224,
      constrainedMemoryBytes: 706_740_224,
    });

    expect(budget.maxWireBytes).toBeGreaterThanOrEqual(22_020_096);
    expect(budget.responseWorkBytes).toBeGreaterThanOrEqual(
      budget.maxWireBytes * budget.jsonAmplification,
    );
    expect(
      budget.activeRequestBytes +
        budget.responseWorkBytes +
        budget.writeQueueBytes +
        budget.sessionCacheBytes +
        budget.responseCaptureBytes,
    ).toBeLessThanOrEqual(Math.floor(budget.processLimitBytes * 0.58));
  });
});
