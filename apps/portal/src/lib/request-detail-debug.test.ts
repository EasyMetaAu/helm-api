import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLookup } from "./api/portal";
import {
  accountPseudonym,
  servingAccountLabel,
} from "./format/serving-account";
import { restoreDetachedImages } from "./request-detail-media";
import * as detailLoader from "./request-detail-load";

const pending: RequestLookup = {
  status: 202,
  data: { status: "in_progress", request_id: "r1", phase: "telemetry_pending" },
};
const signal = () => new AbortController().signal;

afterEach(() => vi.useRealTimers());

describe("debug request detail", () => {
  it("waits two seconds and stops after five pending retries", async () => {
    vi.useFakeTimers();
    const lookup = vi.fn().mockResolvedValue(pending);
    const onPending = vi.fn();
    const result = detailLoader.pollRequestDetail(lookup, onPending, signal());
    await vi.advanceTimersByTimeAsync(1999);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(onPending).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(8001);
    await expect(result).resolves.toBe(pending);
    expect(lookup).toHaveBeenCalledTimes(6);
    expect(onPending).toHaveBeenLastCalledWith(true);
  });

  it("cancels a scheduled retry when the visitor leaves", async () => {
    vi.useFakeTimers();
    const lookup = vi.fn().mockResolvedValue(pending);
    const controller = new AbortController();
    const result = detailLoader.pollRequestDetail(
      lookup,
      vi.fn(),
      controller.signal,
    );
    const cancelled = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.runAllTimersAsync();
    await cancelled;
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("displays only the first eight hex characters of an account pseudonym", () => {
    const account = "acct_0123456789abcdef01234567";
    const label = (id: string) => `Account ${id}`;
    expect(accountPseudonym(account, label)).toBe("Account 01234567");
    expect(
      servingAccountLabel({ provider_id: "anthropic", account }, label),
    ).toBe("Account 01234567");
  });

  it("restores a captured image once and leaves missing references visible", async () => {
    const sha = "a".repeat(64);
    const missing = "b".repeat(64);
    const ref = `helm-blob:sha256:${sha}`;
    const missingRef = `helm-blob:sha256:${missing}`;
    const fetchBlob = vi.fn(async (hash: string) =>
      hash === sha ? "iVBORw0KGgoABC" : null,
    );
    const response = await restoreDetachedImages(
      { url: `data:image/png;base64,${ref}`, bare: ref, missing: missingRef },
      fetchBlob,
    );
    expect(response).toEqual({
      value: {
        url: "data:image/png;base64,iVBORw0KGgoABC",
        bare: "iVBORw0KGgoABC",
        missing: missingRef,
      },
      missing: true,
    });
    expect(fetchBlob.mock.calls).toEqual([[sha], [missing]]);
  });
});
