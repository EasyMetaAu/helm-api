import { randomUUID } from "node:crypto";
import { type ApiKeyRecord, type BudgetCaps, hashKey, type KeyStore } from "@helm/core";
import { effectiveMemoryProjectId, makeHelmError } from "@helm/shared";
import type { MiddlewareHandler } from "hono";

// Resolved request identity, attached to the Hono context for downstream
// (rate limit / classify / route) consumers.
export interface AuthIdentity {
  keyId: string;
  /** Display prefix of the key (e.g. helm_live_ab12). PREFIX ONLY — never the
   *  plaintext key (principle 7). Surfaced in the Debug UI key column. */
  keyPrefix: string;
  accountId: string;
  orgId: string | null;
  userId: string | null;
  role: ApiKeyRecord["role"];
  caps: {
    allowedLanes: string[] | null;
    allowCustomModel: boolean;
    blockedModels: string[] | null;
    /** Per-key cap for client-requested Fast mode passthrough. Account-level Fast
     *  mode can still be forced by subscription account settings. */
    allowFastMode: boolean;
    /** Per-key rate-limit override (docs/06). null = inherit the system default
     *  for that dimension; a number (0 = unlimited) overrides it. Read by the
     *  rate-limit middleware so the limiter needs no extra KeyStore lookup. */
    rateLimit: { rpm: number | null; tpm: number | null };
    /** Per-key max in-flight requests (issue #93). null = unlimited. Read by the
     *  concurrency gate so it needs no extra KeyStore lookup. */
    concurrencyLimit: number | null;
    /** Per-key usage budgets (docs/06). Read by the budget gate so it needs no
     *  extra KeyStore lookup. Each cap null = no cap for that dimension. */
    budget: BudgetCaps;
    /** Per-key memory defaults (issue #97). Read by the memory-scope resolver so
     *  static-header-only / zero-config clients still get memory; explicit
     *  x-memory-* headers always override. */
    memory: {
      mode: "off" | "observe" | "inject";
      projectId: string | null;
      /** Raw user-configured project name. null means the effective scope falls
       *  back to this key's id; kept separate from projectId for portal editing. */
      projectName?: string | null;
      threadSource: "header" | "auto";
    };
  };
}

export interface AuthDeps {
  keyStore: Pick<KeyStore, "getByHash">;
  log: (line: string) => void;
}

declare module "hono" {
  interface ContextVariableMap {
    identity: AuthIdentity;
  }
}

// Extract the plaintext key from Authorization: Bearer <key> (preferred) or the
// x-api-key header. Case-sensitive: never trim/lowercase before hashing.
function extractKey(
  authHeader: string | undefined,
  apiKeyHeader: string | undefined,
): string | null {
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/.exec(authHeader);
    if (match?.[1]) return match[1];
  }
  if (apiKeyHeader) return apiKeyHeader;
  return null;
}

// Hono auth middleware. Mandatory key auth: missing / unknown / disabled -> a
// structured auth_error(401), short-circuiting before any downstream handler.
// Valid -> attach identity and continue. Plaintext keys are NEVER logged or
// echoed in responses (principle 7). Registered BEFORE rate limiting (docs/06).
export function authMiddleware(deps: AuthDeps): MiddlewareHandler {
  return async (c, next) => {
    const traceId = c.req.header("x-trace-id") ?? randomUUID();
    const plaintext = extractKey(c.req.header("Authorization"), c.req.header("x-api-key"));

    const reject = () => {
      const body = makeHelmError({
        error_class: "auth_error",
        message: "missing or invalid API key",
        trace_id: traceId,
      });
      return c.json(body, 401);
    };

    if (plaintext === null) {
      deps.log(`auth_error: missing API key trace_id=${traceId}`);
      return reject();
    }

    const record = await deps.keyStore.getByHash(hashKey(plaintext));
    if (record === null || record.disabled) {
      deps.log(`auth_error: unknown or disabled key trace_id=${traceId}`);
      return reject();
    }

    const identity: AuthIdentity = {
      keyId: record.key_id,
      keyPrefix: record.prefix,
      accountId: record.account_id,
      orgId: null,
      userId: null,
      role: record.role,
      caps: {
        allowedLanes: record.allowed_lanes,
        allowCustomModel: record.allow_custom_model,
        blockedModels: record.blocked_models,
        allowFastMode: record.allow_fast_mode,
        rateLimit: { rpm: record.rate_limit_rpm, tpm: record.rate_limit_tpm },
        concurrencyLimit: record.concurrency_limit,
        budget: {
          requests: record.budget_requests,
          tokens: record.budget_tokens,
          spendUsd: record.budget_spend_usd,
          windowSeconds: record.budget_window_seconds,
          behavior: record.over_budget_behavior,
          degradeLane: record.degrade_lane,
        },
        memory: {
          mode: record.memory_mode,
          // null project => isolate by the key's own id; an explicit value SHARES
          // a pool across keys (effectiveMemoryProjectId). Resolved per request so
          // clearing the column reverts to isolated-by-self with no migration.
          projectId: effectiveMemoryProjectId(record),
          projectName: record.memory_project_id,
          threadSource: record.memory_thread_source,
        },
      },
    };
    c.set("identity", identity);
    await next();
  };
}
