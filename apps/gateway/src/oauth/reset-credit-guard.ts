import { createHash } from "node:crypto";
import type { ConfigStore } from "@helm/core";
import type { OAuthQuotaWindow } from "@helm/shared";
import {
  AUTO_RESET_COOLDOWN_MS,
  CODEX_RESET_MIN_WEEKLY_USED_PERCENT,
  canConsumeResetCredit,
  codexWeeklyUsedPercent,
  cooldownPassed,
} from "./auto-reset.js";

export type ResetCreditSpendMode = "manual" | "auto";

export type ResetCreditGuardResult =
  | { ok: true; sharedKey: string; windowId: string }
  | {
      ok: false;
      status: 409 | 429 | 503;
      code: string;
      error: string;
      retryAfterMs?: number;
    };

export interface ResetCreditGuard {
  reserve(input: {
    providerId: string;
    account: string;
    windows: OAuthQuotaWindow[];
    mode: ResetCreditSpendMode;
    nowMs?: number;
  }): Promise<ResetCreditGuardResult>;
}

export interface ResetCreditGuardDeps {
  config: ConfigStore;
  resolveSharedKey(input: { providerId: string; account: string }): Promise<string>;
  log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

export function resetCreditGuardHash(sharedKey: string): string {
  return createHash("sha256").update(sharedKey, "utf8").digest("hex");
}

export function resetCreditGuardConfigKey(sharedKey: string): string {
  return `oauth.codex_reset_credit.last.v1.${resetCreditGuardHash(sharedKey)}`;
}

export function resetCreditGuardWindowConfigKey(sharedKey: string): string {
  return `oauth.codex_reset_credit.window.v1.${resetCreditGuardHash(sharedKey)}`;
}

export const resetCreditGuardAutoWindowConfigKey = resetCreditGuardWindowConfigKey;

function weeklyWindowId(windows: readonly OAuthQuotaWindow[]): string | null {
  const weekly = windows
    .filter((w) => w.key === "secondary")
    .filter((w) => Number.isFinite(w.usedPercent))
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return weekly?.resetsAtMs == null ? null : `secondary:${weekly.resetsAtMs}`;
}

function cooldownBlocked(
  lastMs: number,
  nowMs: number,
): { ok: false; status: 429; code: string; error: string; retryAfterMs: number } {
  return {
    ok: false,
    status: 429,
    code: "reset_credit_cooldown_active",
    error: "reset credit blocked: a reset credit was already reserved within the last hour",
    retryAfterMs: Math.max(0, lastMs + AUTO_RESET_COOLDOWN_MS - nowMs),
  };
}

export function createResetCreditGuard(deps: ResetCreditGuardDeps): ResetCreditGuard {
  const lastBySharedKey = new Map<string, number>();
  const inFlightSharedKeys = new Set<string>();

  async function readPersistedLast(sharedKey: string): Promise<number | undefined> {
    const raw = await deps.config.get(resetCreditGuardConfigKey(sharedKey));
    if (raw == null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  async function readReservedWindow(sharedKey: string): Promise<string | null> {
    return deps.config.get(resetCreditGuardWindowConfigKey(sharedKey));
  }

  async function writeReservedWindow(sharedKey: string, windowId: string): Promise<void> {
    await deps.config.set(resetCreditGuardWindowConfigKey(sharedKey), windowId);
  }

  async function reserveWindow(sharedKey: string, windows: readonly OAuthQuotaWindow[]) {
    const windowId = weeklyWindowId(windows);
    if (windowId == null) {
      return {
        ok: false,
        status: 409,
        code: "weekly_window_reset_unavailable",
        error: "reset credit blocked: Codex weekly window reset time is unavailable",
      } as const;
    }
    if ((await readReservedWindow(sharedKey)) === windowId) {
      return {
        ok: false,
        status: 409,
        code: "reset_credit_window_already_reserved",
        error: "reset credit blocked: this Codex weekly window already reserved a reset credit",
      } as const;
    }
    return { ok: true, windowId } as const;
  }

  return {
    async reserve({ providerId, account, windows, mode, nowMs = Date.now() }) {
      const weeklyUsedPercent = codexWeeklyUsedPercent(windows);
      if (providerId !== "openai-codex") {
        return {
          ok: false,
          status: 409,
          code: "unsupported_provider",
          error: "reset credit is only supported for openai-codex",
        };
      }
      if (!canConsumeResetCredit(windows)) {
        return {
          ok: false,
          status: 409,
          code: "weekly_usage_below_reset_threshold",
          error: `reset credit blocked: Codex weekly usage must be at least ${CODEX_RESET_MIN_WEEKLY_USED_PERCENT}%`,
        };
      }

      try {
        const sharedKey = await deps.resolveSharedKey({ providerId, account });
        if (inFlightSharedKeys.has(sharedKey)) {
          return cooldownBlocked(nowMs, nowMs);
        }
        inFlightSharedKeys.add(sharedKey);
        try {
          const memoryLast = lastBySharedKey.get(sharedKey);
          if (memoryLast !== undefined && !cooldownPassed(memoryLast, nowMs)) {
            return cooldownBlocked(memoryLast, nowMs);
          }

          const window = await reserveWindow(sharedKey, windows);
          if (!window.ok) return window;

          if (!deps.config.setIfMissingOrNumericLte) {
            throw new Error("ConfigStore does not support atomic reset-credit reserve");
          }
          const cutoffMs = nowMs - AUTO_RESET_COOLDOWN_MS;
          const claimed = await deps.config.setIfMissingOrNumericLte(
            resetCreditGuardConfigKey(sharedKey),
            String(nowMs),
            cutoffMs,
          );
          if (!claimed) {
            const persistedLast = await readPersistedLast(sharedKey);
            if (persistedLast === undefined) {
              throw new Error("reset-credit guard row is not a numeric timestamp");
            }
            lastBySharedKey.set(sharedKey, persistedLast);
            return cooldownBlocked(persistedLast, nowMs);
          }

          await writeReservedWindow(sharedKey, window.windowId);
          lastBySharedKey.set(sharedKey, nowMs);
          deps.log?.("info", "oauth.reset_credit.reserved", {
            provider_id: providerId,
            mode,
            weekly_used_percent: weeklyUsedPercent,
            guard: resetCreditGuardHash(sharedKey).slice(0, 12),
            window: window.windowId,
          });
          return { ok: true, sharedKey, windowId: window.windowId };
        } finally {
          inFlightSharedKeys.delete(sharedKey);
        }
      } catch (e) {
        deps.log?.("error", "oauth.reset_credit.guard_failed", {
          provider_id: providerId,
          mode,
          line: e instanceof Error ? e.message : String(e),
        });
        return {
          ok: false,
          status: 503,
          code: "reset_credit_guard_failed",
          error: "reset credit guard failed closed",
        };
      }
    },
  };
}
