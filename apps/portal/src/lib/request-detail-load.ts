import type { RequestLookup } from "./api/portal";

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

function waitForRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, RETRY_DELAY_MS);
    function cancel(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export async function pollRequestDetail(
  lookup: () => Promise<RequestLookup>,
  onPending: (canRefresh: boolean) => void,
  signal: AbortSignal,
): Promise<RequestLookup> {
  for (let retries = 0; ; retries += 1) {
    signal.throwIfAborted();
    const result = await lookup();
    signal.throwIfAborted();
    if (result.status === 200) return result;
    const canRefresh = retries === MAX_RETRIES;
    onPending(canRefresh);
    if (canRefresh) return result;
    await waitForRetry(signal);
  }
}
