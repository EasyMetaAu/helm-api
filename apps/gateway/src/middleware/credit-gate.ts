import type { CreditCheckResult, CreditProbe } from "@helm/core";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// The credit gate dependency (core, framework-agnostic). The middleware is glue
// ONLY — no balance arithmetic, no quota resolution here (principle 1).
export interface CreditGatePort {
  check(probe: CreditProbe): Promise<CreditCheckResult>;
}

export interface CreditGateMiddlewareDeps {
  gate: CreditGatePort;
  // Optional structured-log sink for the alert path (over quota, served soft).
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

// Pre-request credit gate middleware (Issue #37). Position is a contract: AFTER
// auth (needs the resolved account_id) and AFTER rate limiting, BEFORE
// classify/route (cut off cost before classification/eval). Covers ALL THREE
// protocol faces (OpenAI / Anthropic / Responses) — the post-served DEBIT is
// OpenAI-only (D8), but the GATE applies everywhere.
//   - allowed            -> continue (alert mode may flag a served over-quota req).
//   - !allowed           -> 429 (reject), short-circuit.
// FAIL-CLOSED: a store error from gate.check() PROPAGATES (the global error
// handler turns it into a 5xx) — NEVER an "unlimited" pass-through.
//
// Error class: we reuse the closed-contract `rate_limited` class (already mapped
// to 429 in ERROR_CLASS_HTTP_STATUS) rather than adding a 9th ErrorClass enum
// value — the body's `limited_by: "credit"` distinguishes an insufficient-credit
// rejection from an RPM/TPM one without touching the docs/07 error contract.
export function creditGateMiddleware(deps: CreditGateMiddlewareDeps): MiddlewareHandler {
  return async (c, next) => {
    const identity = c.get("identity") as { accountId?: string } | undefined;
    const accountId = identity?.accountId ?? null;

    const result = await deps.gate.check({ accountId });

    if (result.allowed) {
      if (result.alert) {
        // Over quota but served (soft alert mode). Log the breach with account +
        // balance ONLY — never a key/payload (principle 7).
        deps.log?.("credit.over_quota_alert", { account_id: accountId, balance: result.balance });
      }
      await next();
      return;
    }

    // Hard stop: insufficient credit. Structured 429 (rate_limited class), with
    // limited_by:"credit" so clients/operators can tell it apart from an RPM/TPM
    // limit. The Protocol Adapter may further translate this per client protocol.
    return c.json(
      {
        error: {
          type: "rate_limited" as const,
          message: "insufficient account credit",
          limited_by: "credit" as const,
        },
      },
      429 as ContentfulStatusCode,
    );
  };
}
