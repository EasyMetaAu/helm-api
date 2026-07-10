import { createHash, randomUUID } from "node:crypto";
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

export interface ResetCreditGuardReservation {
  ok: true;
  sharedKey: string;
  windowId: string;
  idempotencyKey: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export type ResetCreditGuardResult =
  | ResetCreditGuardReservation
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
    idempotencyKey?: string;
    rateLimitReachedType?:
      | "rate_limit_reached"
      | "workspace_owner_credits_depleted"
      | "workspace_member_credits_depleted"
      | "workspace_owner_usage_limit_reached"
      | "workspace_member_usage_limit_reached"
      | null;
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

// Header PUSH windows derive `resetsAtMs` from local `nowMs + reset_after_seconds`.
// The logical weekly window is stable, but that derived absolute timestamp can jitter
// by milliseconds/seconds across responses and can differ slightly from the usage
// endpoint's absolute `reset_at`. Treat close reset deadlines as the same weekly
// window so one logical Codex week cannot burn multiple reset credits. Keep the
// tolerance narrow: it absorbs clock/proxy/header drift without masking a real
// weekly-window boundary shift.
const WEEKLY_WINDOW_RESET_TOLERANCE_MS = 30 * 60 * 1000;
const RESET_CREDIT_RESERVATION_LEASE_MS = 2 * 60 * 1000;

export function resetCreditGuardHash(sharedKey: string): string {
  return createHash("sha256").update(sharedKey, "utf8").digest("hex");
}

export function resetCreditGuardConfigKey(sharedKey: string): string {
  return `oauth.codex_reset_credit.last.v1.${resetCreditGuardHash(sharedKey)}`;
}

export function resetCreditGuardWindowConfigKey(sharedKey: string): string {
  return `oauth.codex_reset_credit.window.v1.${resetCreditGuardHash(sharedKey)}`;
}

export function resetCreditGuardPendingConfigKey(sharedKey: string): string {
  return `oauth.codex_reset_credit.pending.v1.${resetCreditGuardHash(sharedKey)}`;
}

export function resetCreditGuardRedeemConfigKey(sharedKey: string): string {
  return `oauth.codex_reset_credit.redeem.v1.${resetCreditGuardHash(sharedKey)}`;
}

export const resetCreditGuardAutoWindowConfigKey = resetCreditGuardWindowConfigKey;

interface WeeklyWindowMarker {
  windowId: string;
  resetAtMs: number;
}

interface RedeemRequestMarker {
  windowId: string;
  idempotencyKey: string;
}

function weeklyWindowMarker(windows: readonly OAuthQuotaWindow[]): WeeklyWindowMarker | null {
  const weekly = windows
    .filter((w) => w.key === "secondary" && (w.limitId === undefined || w.limitId === "codex"))
    .filter((w) => Number.isFinite(w.usedPercent))
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (weekly?.resetsAtMs == null || !Number.isFinite(weekly.resetsAtMs)) return null;
  return {
    windowId: `secondary:${weekly.resetsAtMs}`,
    resetAtMs: weekly.resetsAtMs,
  };
}

function parseReservedWeeklyWindow(raw: string): { key: string; resetAtMs: number } | null {
  const [key, resetAtRaw, ...rest] = raw.split(":");
  if (rest.length > 0 || key !== "secondary") return null;
  const resetAtMs = Number(resetAtRaw);
  return Number.isFinite(resetAtMs) && resetAtMs >= 0 ? { key, resetAtMs } : null;
}

function compareReservedWeeklyWindow(
  reserved: string | null,
  current: WeeklyWindowMarker,
): "none" | "same" | "different" | "invalid" {
  if (reserved === null) return "none";
  if (reserved === current.windowId) return "same";
  const parsed = parseReservedWeeklyWindow(reserved);
  if (!parsed) return "invalid";
  return Math.abs(parsed.resetAtMs - current.resetAtMs) <= WEEKLY_WINDOW_RESET_TOLERANCE_MS
    ? "same"
    : "different";
}

function parseStoredTimestamp(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseRedeemRequestMarker(raw: string): RedeemRequestMarker | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.windowId !== "string" ||
      record.windowId.length === 0 ||
      typeof record.idempotencyKey !== "string" ||
      record.idempotencyKey.length === 0
    ) {
      return null;
    }
    return {
      windowId: record.windowId,
      idempotencyKey: record.idempotencyKey,
    };
  } catch {
    return null;
  }
}

function cooldownBlocked(
  lastMs: number,
  nowMs: number,
): { ok: false; status: 429; code: string; error: string; retryAfterMs: number } {
  return {
    ok: false,
    status: 429,
    code: "reset_credit_cooldown_active",
    error: "reset credit blocked: a reset credit was already consumed within the last hour",
    retryAfterMs: Math.max(0, lastMs + AUTO_RESET_COOLDOWN_MS - nowMs),
  };
}

function reservationBlocked(
  leaseExpiresAtMs: number,
  nowMs: number,
): { ok: false; status: 429; code: string; error: string; retryAfterMs: number } {
  return {
    ok: false,
    status: 429,
    code: "reset_credit_reservation_active",
    error: "reset credit blocked: another reset-credit attempt is still in progress",
    retryAfterMs: Math.max(0, leaseExpiresAtMs - nowMs),
  };
}

export function createResetCreditGuard(deps: ResetCreditGuardDeps): ResetCreditGuard {
  const lastBySharedKey = new Map<string, number>();
  const windowBySharedKey = new Map<string, string>();
  const pendingBySharedKey = new Map<string, number>();

  async function readPersistedLast(sharedKey: string): Promise<number | undefined> {
    const raw = await deps.config.get(resetCreditGuardConfigKey(sharedKey));
    if (raw == null) return undefined;
    const parsed = parseStoredTimestamp(raw);
    if (parsed === null) {
      throw new Error("reset-credit guard row is not a numeric timestamp");
    }
    return parsed;
  }

  async function readReservedWindow(sharedKey: string): Promise<string | null> {
    return (
      windowBySharedKey.get(sharedKey) ??
      (await deps.config.get(resetCreditGuardWindowConfigKey(sharedKey)))
    );
  }

  async function writeReservedWindow(sharedKey: string, windowId: string): Promise<void> {
    await deps.config.set(resetCreditGuardWindowConfigKey(sharedKey), windowId);
  }

  async function reserveWindow(sharedKey: string, windows: readonly OAuthQuotaWindow[]) {
    const window = weeklyWindowMarker(windows);
    if (window == null) {
      return {
        ok: false,
        status: 409,
        code: "weekly_window_reset_unavailable",
        error: "reset credit blocked: Codex weekly window reset time is unavailable",
      } as const;
    }
    const reserved = compareReservedWeeklyWindow(await readReservedWindow(sharedKey), window);
    if (reserved === "invalid") {
      return {
        ok: false,
        status: 503,
        code: "reset_credit_window_guard_corrupt",
        error: "reset credit guard failed closed: stored weekly window marker is invalid",
      } as const;
    }
    if (reserved === "same") {
      return {
        ok: false,
        status: 409,
        code: "reset_credit_window_already_reserved",
        error: "reset credit blocked: this Codex weekly window already reserved a reset credit",
      } as const;
    }
    return { ok: true, windowId: window.windowId } as const;
  }

  async function claimPendingReservation(
    sharedKey: string,
    nowMs: number,
  ): Promise<{ ok: true; leaseExpiresAtMs: number } | { ok: false; leaseExpiresAtMs: number }> {
    if (!deps.config.setIfMissingOrNumericLte) {
      throw new Error("ConfigStore does not support atomic reset-credit reserve");
    }
    const leaseExpiresAtMs = nowMs + RESET_CREDIT_RESERVATION_LEASE_MS;
    const claimed = await deps.config.setIfMissingOrNumericLte(
      resetCreditGuardPendingConfigKey(sharedKey),
      String(leaseExpiresAtMs),
      nowMs,
    );
    if (claimed) return { ok: true, leaseExpiresAtMs };

    const raw = await deps.config.get(resetCreditGuardPendingConfigKey(sharedKey));
    const storedLeaseExpiresAtMs = raw === null ? null : parseStoredTimestamp(raw);
    if (storedLeaseExpiresAtMs === null) {
      throw new Error("reset-credit pending reservation row is not a numeric timestamp");
    }
    return { ok: false, leaseExpiresAtMs: storedLeaseExpiresAtMs };
  }

  async function releasePendingReservation(
    sharedKey: string,
    leaseExpiresAtMs: number,
  ): Promise<void> {
    if (!deps.config.setIfMissingOrNumericLte) return;
    await deps.config.setIfMissingOrNumericLte(
      resetCreditGuardPendingConfigKey(sharedKey),
      "0",
      leaseExpiresAtMs,
    );
  }

  async function resolveRedeemRequestId(
    sharedKey: string,
    windowId: string,
    requestedIdempotencyKey?: string,
  ): Promise<string> {
    const key = resetCreditGuardRedeemConfigKey(sharedKey);
    const raw = await deps.config.get(key);
    if (raw !== null) {
      const stored = parseRedeemRequestMarker(raw);
      if (stored === null) {
        throw new Error("reset-credit redeem request marker is invalid");
      }
      if (stored.windowId === windowId) return stored.idempotencyKey;
    }
    if (requestedIdempotencyKey !== undefined && requestedIdempotencyKey.length === 0) {
      throw new Error("reset-credit idempotency key must not be empty");
    }
    const idempotencyKey = requestedIdempotencyKey ?? randomUUID();
    await deps.config.set(
      key,
      JSON.stringify({
        windowId,
        idempotencyKey,
      } satisfies RedeemRequestMarker),
    );
    return idempotencyKey;
  }

  return {
    async reserve({
      providerId,
      account,
      windows,
      mode,
      idempotencyKey: requestedIdempotencyKey,
      rateLimitReachedType,
      nowMs = Date.now(),
    }) {
      const weeklyUsedPercent = codexWeeklyUsedPercent(windows);
      if (providerId !== "openai-codex") {
        return {
          ok: false,
          status: 409,
          code: "unsupported_provider",
          error: "reset credit is only supported for openai-codex",
        };
      }
      if (!canConsumeResetCredit(windows, rateLimitReachedType)) {
        const reachedTypeBlocks =
          rateLimitReachedType !== undefined &&
          rateLimitReachedType !== null &&
          rateLimitReachedType !== "rate_limit_reached";
        return {
          ok: false,
          status: 409,
          code: reachedTypeBlocks
            ? "reset_credit_not_applicable"
            : "weekly_usage_below_reset_threshold",
          error: reachedTypeBlocks
            ? "reset credit blocked: this Codex limit cannot be restored with a rate-limit reset credit"
            : `reset credit blocked: Codex weekly usage must be at least ${CODEX_RESET_MIN_WEEKLY_USED_PERCENT}%`,
        };
      }

      try {
        const sharedKey = await deps.resolveSharedKey({ providerId, account });
        const localLeaseExpiresAtMs = pendingBySharedKey.get(sharedKey);
        if (localLeaseExpiresAtMs !== undefined && localLeaseExpiresAtMs > nowMs) {
          return reservationBlocked(localLeaseExpiresAtMs, nowMs);
        }
        if (localLeaseExpiresAtMs !== undefined) pendingBySharedKey.delete(sharedKey);

        const memoryLast = lastBySharedKey.get(sharedKey);
        if (memoryLast !== undefined && !cooldownPassed(memoryLast, nowMs)) {
          return cooldownBlocked(memoryLast, nowMs);
        }
        if (memoryLast === undefined) {
          const persistedLast = await readPersistedLast(sharedKey);
          if (persistedLast !== undefined) {
            lastBySharedKey.set(sharedKey, persistedLast);
            if (!cooldownPassed(persistedLast, nowMs)) {
              return cooldownBlocked(persistedLast, nowMs);
            }
          }
        }

        const window = await reserveWindow(sharedKey, windows);
        if (!window.ok) return window;

        const pending = await claimPendingReservation(sharedKey, nowMs);
        if (!pending.ok) {
          return reservationBlocked(pending.leaseExpiresAtMs, nowMs);
        }
        const leaseExpiresAtMs = pending.leaseExpiresAtMs;
        pendingBySharedKey.set(sharedKey, leaseExpiresAtMs);
        let confirmedWindow: Awaited<ReturnType<typeof reserveWindow>>;
        let idempotencyKey: string;
        try {
          const persistedLast = await readPersistedLast(sharedKey);
          if (persistedLast !== undefined && !cooldownPassed(persistedLast, nowMs)) {
            await releasePendingReservation(sharedKey, leaseExpiresAtMs);
            pendingBySharedKey.delete(sharedKey);
            return cooldownBlocked(persistedLast, nowMs);
          }
          confirmedWindow = await reserveWindow(sharedKey, windows);
          if (!confirmedWindow.ok) {
            await releasePendingReservation(sharedKey, leaseExpiresAtMs);
            pendingBySharedKey.delete(sharedKey);
            return confirmedWindow;
          }
          idempotencyKey = await resolveRedeemRequestId(
            sharedKey,
            confirmedWindow.windowId,
            requestedIdempotencyKey,
          );
        } catch (error) {
          try {
            await releasePendingReservation(sharedKey, leaseExpiresAtMs);
          } catch (releaseError) {
            deps.log?.("error", "oauth.reset_credit.setup_release_failed", {
              provider_id: providerId,
              mode,
              guard: resetCreditGuardHash(sharedKey).slice(0, 12),
              line: releaseError instanceof Error ? releaseError.message : String(releaseError),
            });
          } finally {
            pendingBySharedKey.delete(sharedKey);
          }
          throw error;
        }
        let settled = false;

        const releaseLocal = () => {
          if (pendingBySharedKey.get(sharedKey) === leaseExpiresAtMs) {
            pendingBySharedKey.delete(sharedKey);
          }
        };
        const rollback = async () => {
          if (settled) return;
          settled = true;
          try {
            await releasePendingReservation(sharedKey, leaseExpiresAtMs);
          } catch (error) {
            deps.log?.("error", "oauth.reset_credit.rollback_failed", {
              provider_id: providerId,
              mode,
              guard: resetCreditGuardHash(sharedKey).slice(0, 12),
              line: error instanceof Error ? error.message : String(error),
            });
          } finally {
            releaseLocal();
          }
        };
        const commit = async () => {
          if (settled) return;
          settled = true;
          lastBySharedKey.set(sharedKey, nowMs);
          windowBySharedKey.set(sharedKey, confirmedWindow.windowId);
          let windowDurable = false;
          try {
            await writeReservedWindow(sharedKey, confirmedWindow.windowId);
            windowDurable = true;
            await deps.config.set(resetCreditGuardConfigKey(sharedKey), String(nowMs));
            deps.log?.("info", "oauth.reset_credit.committed", {
              provider_id: providerId,
              mode,
              weekly_used_percent: weeklyUsedPercent,
              guard: resetCreditGuardHash(sharedKey).slice(0, 12),
              window: confirmedWindow.windowId,
            });
          } catch (error) {
            deps.log?.("error", "oauth.reset_credit.commit_failed", {
              provider_id: providerId,
              mode,
              guard: resetCreditGuardHash(sharedKey).slice(0, 12),
              window: confirmedWindow.windowId,
              line: error instanceof Error ? error.message : String(error),
            });
          } finally {
            if (windowDurable) {
              try {
                await releasePendingReservation(sharedKey, leaseExpiresAtMs);
              } catch (error) {
                deps.log?.("warn", "oauth.reset_credit.release_failed", {
                  provider_id: providerId,
                  mode,
                  guard: resetCreditGuardHash(sharedKey).slice(0, 12),
                  line: error instanceof Error ? error.message : String(error),
                });
              }
            }
            releaseLocal();
          }
        };

        deps.log?.("info", "oauth.reset_credit.reserved", {
          provider_id: providerId,
          mode,
          weekly_used_percent: weeklyUsedPercent,
          guard: resetCreditGuardHash(sharedKey).slice(0, 12),
          window: confirmedWindow.windowId,
          lease_expires_at_ms: leaseExpiresAtMs,
        });
        return {
          ok: true,
          sharedKey,
          windowId: confirmedWindow.windowId,
          idempotencyKey,
          commit,
          rollback,
        };
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
