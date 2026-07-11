import { describe, expect, it, vi } from "vitest";
import { createOAuthModelDiscoveryCache } from "./model-discovery-cache.js";

const KEY = { providerId: "anthropic", account: "default" };

describe("createOAuthModelDiscoveryCache", () => {
  it("serves account discovery from cache until the positive TTL expires", async () => {
    let now = 1_000;
    const discover = vi.fn(async () => ["claude-fable-5"]);
    const cache = createOAuthModelDiscoveryCache({
      ttlMs: 300_000,
      now: () => now,
    });

    await expect(cache.load(KEY, discover)).resolves.toEqual(["claude-fable-5"]);
    now += 299_999;
    await expect(cache.load(KEY, discover)).resolves.toEqual(["claude-fable-5"]);
    expect(discover).toHaveBeenCalledTimes(1);

    now += 1;
    discover.mockResolvedValueOnce(["claude-sonnet-4-7"]);
    await expect(cache.load(KEY, discover)).resolves.toEqual(["claude-sonnet-4-7"]);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes for the same provider account", async () => {
    let release: ((models: string[]) => void) | undefined;
    const pending = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const discover = vi.fn(() => pending);
    const cache = createOAuthModelDiscoveryCache();

    const first = cache.load(KEY, discover);
    const second = cache.load(KEY, discover);
    release?.(["claude-fable-5"]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      ["claude-fable-5"],
      ["claude-fable-5"],
    ]);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("keeps last-known-good models and negative-caches an empty refresh", async () => {
    let now = 1_000;
    const discover = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["claude-fable-5"])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["claude-opus-4-8"]);
    const cache = createOAuthModelDiscoveryCache({
      ttlMs: 300_000,
      failureTtlMs: 60_000,
      now: () => now,
    });

    await expect(cache.load(KEY, discover)).resolves.toEqual(["claude-fable-5"]);
    now += 300_000;
    await expect(cache.load(KEY, discover)).resolves.toEqual(["claude-fable-5"]);
    now += 59_999;
    await expect(cache.load(KEY, discover)).resolves.toEqual(["claude-fable-5"]);
    expect(discover).toHaveBeenCalledTimes(2);

    now += 1;
    await expect(cache.load(KEY, discover)).resolves.toEqual(["claude-opus-4-8"]);
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it("invalidates only the selected provider account", async () => {
    const cache = createOAuthModelDiscoveryCache();
    const first = vi.fn(async () => ["claude-fable-5"]);
    const second = vi.fn(async () => ["claude-opus-4-8"]);
    const other = vi.fn(async () => ["claude-sonnet-4-7"]);

    await cache.load(KEY, first);
    await cache.load({ providerId: "anthropic", account: "other" }, other);
    cache.invalidate(KEY);

    await expect(cache.load(KEY, second)).resolves.toEqual(["claude-opus-4-8"]);
    await expect(cache.load({ providerId: "anthropic", account: "other" }, other)).resolves.toEqual(
      ["claude-sonnet-4-7"],
    );
    expect(second).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
  });
});
