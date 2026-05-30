import { z } from "zod";

// Structured error model. core produces a unified internal error; the Protocol
// Adapter's responseOut translates it into each client protocol's error shape
// (docs/05, 07). The error_class -> HTTP status table is the single source of
// truth (no magic numbers scattered in the gateway). Per CLAUDE.md principle 7,
// message/provider_raw must already be redacted by the producer.

// The 8 error classes from docs/07, in document order.
export const ErrorClassSchema = z.enum([
  "auth_error",
  "invalid_request",
  "lane_unavailable",
  "all_providers_failed",
  "capability_unsatisfiable",
  "upstream_error",
  "timeout",
  "rate_limited",
]);

export type ErrorClass = z.infer<typeof ErrorClassSchema>;

export const HelmErrorSchema = z.object({
  error_class: ErrorClassSchema,
  http_status: z.number().int(), // must equal the mapped value (see factory + tests)
  message: z.string(), // redacted, human-readable
  trace_id: z.string().min(1), // links the decision record; restorable in the Debug UI
  provider_raw: z.record(z.string(), z.unknown()).nullable(), // upstream raw error (redacted)
});

export type HelmError = z.infer<typeof HelmErrorSchema>;

// Authoritative map: error_class -> suggested HTTP status (docs/07 table).
// Typed as Record<ErrorClass, number> so adding/removing an enum value without
// updating the map is a compile error (exhaustiveness guard).
export const ERROR_CLASS_HTTP_STATUS: Record<ErrorClass, number> = {
  auth_error: 401,
  invalid_request: 400,
  lane_unavailable: 503,
  all_providers_failed: 502,
  capability_unsatisfiable: 422,
  upstream_error: 502,
  timeout: 504,
  rate_limited: 429,
};

// Factory: guarantees http_status matches the map; callers cannot supply a
// status that disagrees with the class.
export function makeHelmError(args: {
  error_class: ErrorClass;
  message: string;
  trace_id: string;
  provider_raw?: Record<string, unknown> | null;
}): HelmError {
  return HelmErrorSchema.parse({
    error_class: args.error_class,
    http_status: ERROR_CLASS_HTTP_STATUS[args.error_class],
    message: args.message,
    trace_id: args.trace_id,
    provider_raw: args.provider_raw ?? null,
  });
}
