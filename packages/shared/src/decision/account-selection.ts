import { z } from "zod";

export const OAuthSelectionStrategySchema = z.enum([
  "balanced",
  "manual_priority",
  "low_risk",
  "use_expiring",
  "fastest",
]);
export const AccountSelectionTraceSchema = z.object({
  strategy: OAuthSelectionStrategySchema,
  reason: z.enum(["sticky_hit", "hash_assign", "lru", "strategy"]),
  captured_at_ms: z.number().nonnegative(),
  omitted_candidates: z.number().int().nonnegative(),
  candidates: z
    .array(
      z.object({
        account: z.string(),
        selected: z.boolean(),
        priority: z.number(),
        exclusion: z
          .enum([
            "disabled",
            "unsupported_model",
            "quota_limit",
            "cooldown",
            "already_tried",
            "identity_pin",
            "capacity",
            "priority",
            "credit_tier",
          ])
          .nullable(),
        quota_fresh: z.boolean(),
        quota_pressure: z.number().nullable(),
        expiring_value: z.number().nullable(),
        next_reset_ms: z.number().nullable(),
        ttft_ms: z.number().nullable(),
        tokens_per_second: z.number().nullable(),
      }),
    )
    .max(20),
});
export type AccountSelectionTrace = z.infer<typeof AccountSelectionTraceSchema>;
