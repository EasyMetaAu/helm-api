import { describe, expect, it, vi } from "vitest";
import { adminWindowCacheKey, createAdminReadCache } from "./read-cache.js";

describe("createAdminReadCache", () => {
  it("coalesces concurrent misses and serves a fresh value without loading again", async () => {
    let now = 1_000;
    let resolve!: (value: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const cache = createAdminReadCache<string>({ now: () => now });

    const first = cache.get("stats", load);
    const second = cache.get("stats", load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    resolve("snapshot");

    await expect(first).resolves.toEqual({ value: "snapshot", status: "miss" });
    await expect(second).resolves.toEqual({ value: "snapshot", status: "coalesced" });
    now += 5_000;
    await expect(cache.get("stats", load)).resolves.toEqual({
      value: "snapshot",
      status: "fresh",
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("returns stale data immediately and schedules one background refresh", async () => {
    let now = 1_000;
    const scheduled: Array<() => void> = [];
    const load = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const cache = createAdminReadCache<string>({
      freshTtlMs: 10_000,
      staleTtlMs: 300_000,
      now: () => now,
      schedule: (run) => scheduled.push(run),
    });

    await expect(cache.get("stats", load)).resolves.toEqual({ value: "old", status: "miss" });
    now += 10_001;
    await expect(cache.get("stats", load)).resolves.toEqual({ value: "old", status: "stale" });
    await expect(cache.get("stats", load)).resolves.toEqual({ value: "old", status: "stale" });
    expect(scheduled).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);

    scheduled[0]?.();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect(await cache.get("stats", load)).toEqual({ value: "new", status: "fresh" }),
    );
  });

  it("does not retain a failed cold load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("db busy")).mockResolvedValueOnce("ok");
    const cache = createAdminReadCache<string>();

    await expect(cache.get("stats", load)).rejects.toThrow("db busy");
    await expect(cache.get("stats", load)).resolves.toEqual({ value: "ok", status: "miss" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("uses a stable key for live rolling presets but keeps completed windows exact", () => {
    const common = { dimensions: ["hour", 480] as const, startWasDefault: false };
    const first = adminWindowCacheKey({
      ...common,
      start: 10_000,
      end: 10_000 + 3_600_000,
      now: 10_000 + 3_600_000,
      endWasDefault: true,
    });
    const later = adminWindowCacheKey({
      ...common,
      start: 20_000,
      end: 20_000 + 3_600_000,
      now: 20_000 + 3_600_000,
      endWasDefault: true,
    });
    expect(later).toBe(first);

    const completed = adminWindowCacheKey({
      ...common,
      start: 10_000,
      end: 20_000,
      now: 9_999_999,
      endWasDefault: false,
    });
    expect(completed).not.toBe(first);
  });
});
