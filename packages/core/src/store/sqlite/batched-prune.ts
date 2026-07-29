export const SQLITE_PRUNE_BATCH_SIZE = 10;

export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export async function runBatchedPrune(
  deleteBatch: (limit: number) => number,
  yieldBatch: () => Promise<void> = yieldToEventLoop,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const changes = deleteBatch(SQLITE_PRUNE_BATCH_SIZE);
    deleted += changes;
    if (changes < SQLITE_PRUNE_BATCH_SIZE) return deleted;
    await yieldBatch();
  }
}
