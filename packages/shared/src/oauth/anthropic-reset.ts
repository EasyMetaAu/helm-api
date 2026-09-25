import { z } from "zod";

export const AnthropicResetGrantSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  label: z.string().max(200).nullish(),
  resets_total: z.number().int().nonnegative(),
  resets_left: z.number().int().nonnegative(),
  starts_at: z.iso.datetime({ offset: true }).nullish(),
  ends_at: z.iso.datetime({ offset: true }),
  clears: z.array(z.string().max(80)).max(32),
  paused: z.boolean(),
  usable_now: z.boolean(),
  use_requires_limit: z.boolean().default(true),
  blocking: z.array(z.string().max(80)).max(32).default([]),
});
export const AnthropicResetStatusSchema = z.object({
  eligible: z.boolean(),
  ineligible_reason: z.string().max(200).nullish(),
  at_limit: z.boolean().default(false),
  exhausted: z.array(z.string().max(80)).max(32).default([]),
  next_grant_id: z.string().max(40).nullable().default(null),
  weekly_resets_at: z.iso.datetime({ offset: true }).nullish(),
  cooldown_until: z.iso.datetime({ offset: true }).nullish(),
  grants: z.array(AnthropicResetGrantSchema).max(64).default([]),
  pending: z.boolean().default(false),
});
export type AnthropicResetStatus = z.infer<typeof AnthropicResetStatusSchema>;
export type AnthropicResetGrant = z.infer<typeof AnthropicResetGrantSchema>;

export const AnthropicResetRequestSchema = z
  .object({
    account: z.string().min(1).max(200),
    grantId: AnthropicResetGrantSchema.shape.id,
    expectedResetsLeft: z.number().int().positive(),
  })
  .strict();
export type AnthropicResetRequest = z.infer<typeof AnthropicResetRequestSchema>;

export const AnthropicResetResultSchema = z.object({
  result: z.enum([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
    "unknown",
  ]),
  status: AnthropicResetStatusSchema.nullable(),
  quotaRefreshed: z.boolean(),
});
export type AnthropicResetResult = z.infer<typeof AnthropicResetResultSchema>;

// Upstream scope names, not model names. Unknown scopes must not authorize spending.
export const ANTHROPIC_RESET_WINDOW_KEYS: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d-opus",
  seven_day_sonnet: "7d-sonnet",
  seven_day_overage_included: "7d-overage-included",
  seven_day_cowork: "7d-cowork",
  seven_day_omelette: "7d-omelette",
  seven_day_oauth_apps: "7d-oauth-apps",
};

export function usableAnthropicResetGrant(
  status: AnthropicResetStatus,
  nowMs: number,
): AnthropicResetGrant | null {
  if (
    !status.eligible ||
    status.pending ||
    (status.cooldown_until && Date.parse(status.cooldown_until) > nowMs)
  )
    return null;
  return (
    status.grants.find(
      (g) =>
        g.id === status.next_grant_id &&
        g.usable_now &&
        !g.paused &&
        g.resets_left > 0 &&
        g.resets_left <= g.resets_total &&
        g.blocking.every((key) => g.clears.includes(key)) &&
        Date.parse(g.ends_at) > nowMs &&
        (!g.starts_at || Date.parse(g.starts_at) <= nowMs) &&
        g.clears.length > 0 &&
        g.clears.every((key) => Object.hasOwn(ANTHROPIC_RESET_WINDOW_KEYS, key)) &&
        (!g.use_requires_limit ||
          (status.at_limit && g.clears.some((key) => status.exhausted.includes(key)))),
    ) ?? null
  );
}
