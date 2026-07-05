import type { ConfigStore } from "@helm/core";
import type { OAuthQuotaWindow } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { AUTO_RESET_COOLDOWN_MS } from "./auto-reset.js";
import {
  createResetCreditGuard,
  resetCreditGuardConfigKey,
  resetCreditGuardWindowConfigKey,
} from "./reset-credit-guard.js";

class MemoryConfig implements ConfigStore {
  readonly values = new Map<string, string>();
  readonly get = vi.fn(async (key: string) => this.values.get(key) ?? null);
  readonly set = vi.fn(async (key: string, value: string) => {
    this.values.set(key, value);
  });
  readonly setIfMissingOrNumericLte = vi.fn(async (key: string, value: string, lte: number) => {
    const current = this.values.get(key);
    if (current === undefined) {
      this.values.set(key, value);
      return true;
    }
    if (!/^\d+$/.test(current)) return false;
    if (Number(current) <= lte) {
      this.values.set(key, value);
      return true;
    }
    return false;
  });
}

const weeklyWindow = (
  usedPercent: number,
  resetsAtMs = Date.now() + 86_400_000,
): OAuthQuotaWindow => ({
  key: "secondary",
  usedPercent,
  resetsAtMs,
  windowMinutes: 10_080,
});

const weekly = (usedPercent: number): OAuthQuotaWindow[] => [weeklyWindow(usedPercent)];

describe("createResetCreditGuard", () => {
  it("persists the one-hour cooldown by shared account so a restart cannot spend again", async () => {
    const config = new MemoryConfig();
    const resolveSharedKey = vi.fn(async () => "codex:shared-account");
    const now = 1_000_000;
    const first = createResetCreditGuard({ config, resolveSharedKey });

    await expect(
      first.reserve({
        providerId: "openai-codex",
        account: "work-a",
        windows: weekly(100),
        mode: "auto",
        nowMs: now,
      }),
    ).resolves.toMatchObject({ ok: true });

    const persistedKey = resetCreditGuardConfigKey("codex:shared-account");
    expect(config.values.get(persistedKey)).toBe(String(now));
    expect(persistedKey).not.toContain("shared-account");

    const afterRestart = createResetCreditGuard({ config, resolveSharedKey });
    const blocked = await afterRestart.reserve({
      providerId: "openai-codex",
      account: "work-b",
      windows: weekly(100),
      mode: "auto",
      nowMs: now + AUTO_RESET_COOLDOWN_MS / 2,
    });

    expect(blocked).toMatchObject({
      ok: false,
      status: 429,
      code: "reset_credit_cooldown_active",
      retryAfterMs: AUTO_RESET_COOLDOWN_MS / 2,
    });
  });

  it("does not reserve or resolve the account when weekly usage is below 90%", async () => {
    const config = new MemoryConfig();
    const resolveSharedKey = vi.fn(async () => "codex:shared-account");
    const guard = createResetCreditGuard({ config, resolveSharedKey });

    const result = await guard.reserve({
      providerId: "openai-codex",
      account: "work",
      windows: weekly(89),
      mode: "manual",
      nowMs: 1_000,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "weekly_usage_below_reset_threshold",
    });
    expect(resolveSharedKey).not.toHaveBeenCalled();
    expect(config.set).not.toHaveBeenCalled();
    expect(config.setIfMissingOrNumericLte).not.toHaveBeenCalled();
  });

  it("allows only one reset-credit reservation for the same weekly window", async () => {
    const config = new MemoryConfig();
    const resolveSharedKey = vi.fn(async () => "codex:shared-account");
    const guard = createResetCreditGuard({ config, resolveSharedKey });
    const now = 4_000_000;
    const windowReset = now + 3 * 86_400_000;

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work-a",
        windows: [weeklyWindow(100, windowReset)],
        mode: "auto",
        nowMs: now,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(config.values.get(resetCreditGuardWindowConfigKey("codex:shared-account"))).toBe(
      `secondary:${windowReset}`,
    );

    const sameWindowAfterCooldown = await guard.reserve({
      providerId: "openai-codex",
      account: "work-b",
      windows: [weeklyWindow(100, windowReset)],
      mode: "auto",
      nowMs: now + AUTO_RESET_COOLDOWN_MS,
    });
    expect(sameWindowAfterCooldown).toMatchObject({
      ok: false,
      status: 409,
      code: "reset_credit_window_already_reserved",
    });

    const sameManualWindowAfterCooldown = await guard.reserve({
      providerId: "openai-codex",
      account: "work-b",
      windows: [weeklyWindow(100, windowReset)],
      mode: "manual",
      nowMs: now + 2 * AUTO_RESET_COOLDOWN_MS,
    });
    expect(sameManualWindowAfterCooldown).toMatchObject({
      ok: false,
      status: 409,
      code: "reset_credit_window_already_reserved",
    });

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work-b",
        windows: [weeklyWindow(100, windowReset + 86_400_000)],
        mode: "auto",
        nowMs: now + 2 * AUTO_RESET_COOLDOWN_MS,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("treats small weekly reset timestamp jitter as the same reserved window", async () => {
    const config = new MemoryConfig();
    const resolveSharedKey = vi.fn(async () => "codex:shared-account");
    const guard = createResetCreditGuard({ config, resolveSharedKey });
    const now = 5_000_000;
    const windowReset = now + 3 * 86_400_000;

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work-a",
        windows: [weeklyWindow(100, windowReset)],
        mode: "auto",
        nowMs: now,
      }),
    ).resolves.toMatchObject({ ok: true });

    const jitteredSameWindow = await guard.reserve({
      providerId: "openai-codex",
      account: "work-b",
      windows: [weeklyWindow(100, windowReset + 5 * 60_000)],
      mode: "manual",
      nowMs: now + AUTO_RESET_COOLDOWN_MS,
    });

    expect(jitteredSameWindow).toMatchObject({
      ok: false,
      status: 409,
      code: "reset_credit_window_already_reserved",
    });
  });

  it("allows a reset deadline just outside the jitter tolerance", async () => {
    const config = new MemoryConfig();
    const resolveSharedKey = vi.fn(async () => "codex:shared-account");
    const guard = createResetCreditGuard({ config, resolveSharedKey });
    const now = 5_500_000;
    const windowReset = now + 3 * 86_400_000;

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work-a",
        windows: [weeklyWindow(100, windowReset)],
        mode: "auto",
        nowMs: now,
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work-b",
        windows: [weeklyWindow(100, windowReset + 31 * 60_000)],
        mode: "auto",
        nowMs: now + AUTO_RESET_COOLDOWN_MS,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("fails closed when the reserved weekly window marker is corrupt", async () => {
    const config = new MemoryConfig();
    const resolveSharedKey = vi.fn(async () => "codex:shared-account");
    const guard = createResetCreditGuard({ config, resolveSharedKey });
    const now = 5_750_000;

    config.values.set(resetCreditGuardWindowConfigKey("codex:shared-account"), "not-a-window");

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work",
        windows: [weeklyWindow(100, now + 3 * 86_400_000)],
        mode: "manual",
        nowMs: now,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      code: "reset_credit_window_guard_corrupt",
    });
  });

  it("blocks reset-credit reserve when the weekly window cannot be identified", async () => {
    const config = new MemoryConfig();
    const guard = createResetCreditGuard({
      config,
      resolveSharedKey: vi.fn(async () => "codex:shared-account"),
    });

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work",
        windows: [{ key: "secondary", usedPercent: 100, resetsAtMs: null, windowMinutes: 10_080 }],
        mode: "auto",
        nowMs: 1_000,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "weekly_window_reset_unavailable",
    });
  });

  it("allows another reserve after the full cooldown has elapsed", async () => {
    const config = new MemoryConfig();
    const resolveSharedKey = vi.fn(async () => "codex:shared-account");
    const guard = createResetCreditGuard({ config, resolveSharedKey });
    const now = 2_000_000;
    const windowReset = now + 86_400_000;

    await guard.reserve({
      providerId: "openai-codex",
      account: "work",
      windows: [weeklyWindow(100, windowReset)],
      mode: "manual",
      nowMs: now,
    });

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work",
        windows: [weeklyWindow(100, windowReset + 86_400_000)],
        mode: "manual",
        nowMs: now + AUTO_RESET_COOLDOWN_MS,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("atomically allows only one cross-instance cooldown reservation", async () => {
    const config = new MemoryConfig();
    const now = 7_000_000;
    const makeGuard = () =>
      createResetCreditGuard({
        config,
        resolveSharedKey: vi.fn(async () => "codex:shared-account"),
      });

    const [a, b] = await Promise.all([
      makeGuard().reserve({
        providerId: "openai-codex",
        account: "work-a",
        windows: [weeklyWindow(100, now + 86_400_000)],
        mode: "auto",
        nowMs: now,
      }),
      makeGuard().reserve({
        providerId: "openai-codex",
        account: "work-b",
        windows: [weeklyWindow(100, now + 2 * 86_400_000)],
        mode: "auto",
        nowMs: now,
      }),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ status: 429, code: "reset_credit_cooldown_active" }),
    ]);
    expect(config.setIfMissingOrNumericLte).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the durable store cannot reserve atomically", async () => {
    const config: ConfigStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error("unexpected set");
      }),
      setIfMissingOrNumericLte: vi.fn(async () => {
        throw new Error("disk unavailable");
      }),
    };
    const guard = createResetCreditGuard({
      config,
      resolveSharedKey: vi.fn(async () => "codex:shared-account"),
    });

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work",
        windows: weekly(100),
        mode: "auto",
        nowMs: 1_000,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      code: "reset_credit_guard_failed",
    });
  });

  it("fails closed when the durable store lacks atomic reservation support", async () => {
    const config: ConfigStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    };
    const guard = createResetCreditGuard({
      config,
      resolveSharedKey: vi.fn(async () => "codex:shared-account"),
    });

    await expect(
      guard.reserve({
        providerId: "openai-codex",
        account: "work",
        windows: weekly(100),
        mode: "manual",
        nowMs: 1_000,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      code: "reset_credit_guard_failed",
    });
  });
});
