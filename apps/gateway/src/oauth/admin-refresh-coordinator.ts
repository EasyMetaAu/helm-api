export type OAuthAdminRefreshState = "idle" | "queued" | "running" | "succeeded" | "failed";

export interface OAuthAdminRefreshStatus {
  state: OAuthAdminRefreshState;
  jobId: string | null;
  requestedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastSuccessAt: number | null;
  nextAllowedAt: number | null;
  error: string | null;
}

export interface OAuthAdminRefreshEnqueueResult {
  accepted: boolean;
  coalesced: boolean;
  retryAfterMs: number;
  status: OAuthAdminRefreshStatus;
}

export interface OAuthAdminRefreshCoordinator {
  enqueue(): OAuthAdminRefreshEnqueueResult;
  status(): OAuthAdminRefreshStatus;
  waitForIdle(): Promise<void>;
}

export interface OAuthAdminRefreshCoordinatorOptions {
  refresh: () => Promise<void>;
  cooldownMs?: number;
  now?: () => number;
  generateJobId?: () => string;
}

const DEFAULT_COOLDOWN_MS = 60_000;

function cloneStatus(status: OAuthAdminRefreshStatus): OAuthAdminRefreshStatus {
  return { ...status };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "provider refresh failed";
}

export function createOAuthAdminRefreshCoordinator(
  options: OAuthAdminRefreshCoordinatorOptions,
): OAuthAdminRefreshCoordinator {
  const now = options.now ?? (() => Date.now());
  const cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const generateJobId = options.generateJobId ?? (() => crypto.randomUUID());
  let active: Promise<void> | null = null;
  let current: OAuthAdminRefreshStatus = {
    state: "idle",
    jobId: null,
    requestedAt: null,
    startedAt: null,
    finishedAt: null,
    lastSuccessAt: null,
    nextAllowedAt: null,
    error: null,
  };

  function result(accepted: boolean, coalesced: boolean): OAuthAdminRefreshEnqueueResult {
    const currentTime = now();
    return {
      accepted,
      coalesced,
      retryAfterMs:
        current.nextAllowedAt === null ? 0 : Math.max(0, current.nextAllowedAt - currentTime),
      status: cloneStatus(current),
    };
  }

  return {
    enqueue() {
      if (active !== null) return result(false, true);
      const currentTime = now();
      if (current.nextAllowedAt !== null && current.nextAllowedAt > currentTime) {
        return result(false, true);
      }

      current = {
        state: "queued",
        jobId: generateJobId(),
        requestedAt: currentTime,
        startedAt: null,
        finishedAt: null,
        lastSuccessAt: current.lastSuccessAt,
        nextAllowedAt: null,
        error: null,
      };
      active = Promise.resolve()
        .then(async () => {
          current = { ...current, state: "running", startedAt: now() };
          await options.refresh();
          const finishedAt = now();
          current = {
            ...current,
            state: "succeeded",
            finishedAt,
            lastSuccessAt: finishedAt,
            nextAllowedAt: finishedAt + cooldownMs,
            error: null,
          };
        })
        .catch((error: unknown) => {
          const finishedAt = now();
          current = {
            ...current,
            state: "failed",
            finishedAt,
            nextAllowedAt: finishedAt + cooldownMs,
            error: safeErrorMessage(error),
          };
        })
        .finally(() => {
          active = null;
        });
      return result(true, false);
    },

    status() {
      return cloneStatus(current);
    },

    async waitForIdle() {
      while (active !== null) await active;
    },
  };
}
