import { describe, expect, it, vi } from "vitest";
import { createTrackedBackgroundTasks } from "../runtime/maintenance-gate.js";
import { createOAuthAdminRefreshCoordinator } from "./admin-refresh-coordinator.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OAuth admin refresh coordinator", () => {
  it("registers refresh work so maintenance waits after enqueue returns", async () => {
    const background = createTrackedBackgroundTasks();
    const gate = deferred();
    const runInBackground = vi.fn(background.run);
    const coordinator = createOAuthAdminRefreshCoordinator({
      refresh: () => gate.promise,
      runInBackground,
    });

    expect(coordinator.enqueue().accepted).toBe(true);
    expect(runInBackground).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(coordinator.status().state).toBe("running"));
    let paused = false;
    const waiting = background.pauseAndWait().then(() => {
      paused = true;
    });
    await Promise.resolve();
    expect(paused).toBe(false);

    gate.resolve();
    await waiting;
    expect(paused).toBe(true);
  });

  it("fails cleanly when the runtime no longer accepts background work", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createOAuthAdminRefreshCoordinator({
      refresh,
      runInBackground: () => false,
    });

    expect(coordinator.enqueue()).toMatchObject({
      accepted: false,
      coalesced: false,
      status: { state: "failed", error: "refresh queue unavailable" },
    });
    await coordinator.waitForIdle();
    expect(refresh).not.toHaveBeenCalled();
    expect(coordinator.enqueue()).toMatchObject({ accepted: false, coalesced: false });
  });

  it("coalesces concurrent refresh clicks into one running job", async () => {
    const gate = deferred();
    const refresh = vi.fn(() => gate.promise);
    const coordinator = createOAuthAdminRefreshCoordinator({
      refresh,
      generateJobId: () => "refresh-1",
    });

    const first = coordinator.enqueue();
    const followers = Array.from({ length: 19 }, () => coordinator.enqueue());
    await vi.waitFor(() => expect(coordinator.status().state).toBe("running"));

    expect(first).toMatchObject({ accepted: true, coalesced: false });
    expect(followers).toHaveLength(19);
    expect(followers.every((result) => result.coalesced)).toBe(true);
    expect(new Set([first, ...followers].map((result) => result.status.jobId))).toEqual(
      new Set(["refresh-1"]),
    );
    expect(refresh).toHaveBeenCalledOnce();

    gate.resolve();
    await coordinator.waitForIdle();
    expect(coordinator.status()).toMatchObject({ state: "succeeded", jobId: "refresh-1" });
  });

  it("rejects a new job during the post-success cooldown", async () => {
    let now = 1_000;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createOAuthAdminRefreshCoordinator({
      refresh,
      now: () => now,
      cooldownMs: 60_000,
      generateJobId: () => "refresh-1",
    });

    coordinator.enqueue();
    await coordinator.waitForIdle();
    now += 30_000;
    const blocked = coordinator.enqueue();

    expect(blocked).toMatchObject({
      accepted: false,
      coalesced: true,
      retryAfterMs: 30_000,
      status: { state: "succeeded", jobId: "refresh-1", nextAllowedAt: 61_000 },
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("starts a new job after the cooldown expires", async () => {
    let now = 1_000;
    let sequence = 0;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createOAuthAdminRefreshCoordinator({
      refresh,
      now: () => now,
      cooldownMs: 60_000,
      generateJobId: () => `refresh-${++sequence}`,
    });

    coordinator.enqueue();
    await coordinator.waitForIdle();
    now = 61_000;
    const second = coordinator.enqueue();
    await coordinator.waitForIdle();

    expect(second).toMatchObject({ accepted: true, coalesced: false });
    expect(second.status.jobId).toBe("refresh-2");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("records a failed job and releases the queue", async () => {
    let now = 1_000;
    let shouldFail = true;
    const refresh = vi.fn(async () => {
      if (shouldFail) throw new Error("upstream timeout");
    });
    const coordinator = createOAuthAdminRefreshCoordinator({
      refresh,
      now: () => now,
      cooldownMs: 60_000,
      generateJobId: () => "refresh-1",
    });

    coordinator.enqueue();
    await coordinator.waitForIdle();

    expect(coordinator.status()).toMatchObject({
      state: "failed",
      error: "upstream timeout",
      nextAllowedAt: 61_000,
    });

    shouldFail = false;
    now = 61_000;
    expect(coordinator.enqueue()).toMatchObject({ accepted: true });
    await coordinator.waitForIdle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
