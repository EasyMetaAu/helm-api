import { randomUUID } from "node:crypto";
import { type ApiKeyRecord, hashKey, type KeyStore } from "@helm/core";
import { makeHelmError } from "@helm/shared";
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
    /** Per-key rate-limit override (docs/06). null = inherit the system default
     *  for that dimension; a number (0 = unlimited) overrides it. Read by the
     *  rate-limit middleware so the limiter needs no extra KeyStore lookup. */
    rateLimit: { rpm: number | null; tpm: number | null };
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
        rateLimit: { rpm: record.rate_limit_rpm, tpm: record.rate_limit_tpm },
      },
    };
    c.set("identity", identity);
    await next();
  };
}
