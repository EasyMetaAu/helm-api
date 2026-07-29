import { describe, expect, it, vi } from "vitest";
import { runBatchedPrune, SQLITE_PRUNE_BATCH_SIZE } from "./batched-prune.js";

describe("runBatchedPrune", () => {
  it("keeps deleting in small batches and yields between full batches", async () => {
    const batches = [SQLITE_PRUNE_BATCH_SIZE, SQLITE_PRUNE_BATCH_SIZE, 3];
    const deleteBatch = vi.fn(() => batches.shift() ?? 0);
    const yieldToEventLoop = vi.fn(async () => {});

    await expect(runBatchedPrune(deleteBatch, yieldToEventLoop)).resolves.toBe(
      SQLITE_PRUNE_BATCH_SIZE * 2 + 3,
    );
    expect(deleteBatch).toHaveBeenCalledTimes(3);
    expect(deleteBatch).toHaveBeenNthCalledWith(1, SQLITE_PRUNE_BATCH_SIZE);
    expect(deleteBatch).toHaveBeenNthCalledWith(2, SQLITE_PRUNE_BATCH_SIZE);
    expect(deleteBatch).toHaveBeenNthCalledWith(3, SQLITE_PRUNE_BATCH_SIZE);
    expect(yieldToEventLoop).toHaveBeenCalledTimes(2);
  });
});
