import { z } from "zod";

// Per-account OAuth subscription USAGE + QUOTA observability (providers-page
// enrichment). These are OBSERVABILITY artifacts, never a security boundary, so
// every read/write path is FAIL-OPEN: a malformed row / upstream payload must
// never 5xx a chat request nor break the admin page (CLAUDE.md Principle 3).
// Single source of truth via z.infer.

// ── Usage (Tier 2): served traffic per (provider, account) over a window ──────

// One usage row ROLLED UP over a query window (the providers page reads the admin's
// local day). The store keeps finer per-hour buckets internally; `queryRange` sums
// them per (providerId, account), so this shape carries NO bucket field. `requests`
// counts served calls; `tokens` is the total served tokens (prompt+completion,
// summed across calls); `costUsd` is the summed completion cost — NULLABLE because
// subscription plans are flat-rate (no per-token price), so null = "unpriced",
// distinct from a measured 0. `firstSeenMs` (MIN over the window) anchors the
// daily-average RPM derivation; `updatedAt` is the latest write (MAX) in the window.
export const OAuthUsageRowSchema = z
  .object({
    providerId: z.string(),
    account: z.string(),
    requests: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costUsd: z.number().nullable(),
    firstSeenMs: z.number().int(), // epoch ms of the window's first served call
    updatedAt: z.number().int(), // epoch ms of the latest write in the window
  })
  .strict();

export type OAuthUsageRow = z.infer<typeof OAuthUsageRowSchema>;

// ── Quota (Tier 3): latest rate-limit window snapshot per (provider, account) ─

// One rate-limit window. `key` names the window (Claude: 5h / 7d / 7d-opus /
// 7d-sonnet / 7d-fable; Codex: primary / secondary). `usedPercent` is normally
// 0–100, but Codex preserves the upstream number verbatim and can report values
// above 100 while a limit is exceeded. The UI clamps only the progress-bar width.
// `resetsAtMs` is the epoch ms the window resets (null when unknown).
// `windowMinutes` is the window length when the provider reports it (Codex), else
// null.
export const OAuthQuotaWindowSchema = z
  .object({
    key: z.string(),
    usedPercent: z.number().min(0),
    resetsAtMs: z.number().int().nullable(),
    windowMinutes: z.number().int().positive().nullable().default(null),
    // Codex additional_rate_limits only. The default Codex bucket and Anthropic
    // windows omit these fields for backward compatibility.
    limitId: z.string().optional(),
    limitName: z.string().nullable().optional(),
  })
  .strict();

export type OAuthQuotaWindow = z.infer<typeof OAuthQuotaWindowSchema>;

type CodexQuotaWindowCandidate = Pick<OAuthQuotaWindow, "key" | "usedPercent"> &
  Partial<Pick<OAuthQuotaWindow, "windowMinutes" | "resetsAtMs" | "limitId">>;

// Some Codex response-header families expose an empty positional window even
// though the account has no second allowance: 0% used, no duration, and a reset
// deadline that is already expired at capture time. It is transport padding, not
// quota truth, so callers may discard it both before persistence and on cached
// reads of snapshots written by older Helm versions.
export function isCodexQuotaWindowPlaceholder(
  window: CodexQuotaWindowCandidate,
  capturedAtMs: number,
): boolean {
  return (
    window.usedPercent === 0 &&
    window.windowMinutes == null &&
    (window.resetsAtMs == null || window.resetsAtMs <= capturedAtMs)
  );
}

// Weekly selection is collection-level because an unknown-duration `secondary`
// is only a legacy fallback when the same snapshot has no duration-backed weekly
// account window. Model-scoped limits never participate in account reset credits.
export function selectCodexAccountWeeklyQuotaWindows<T extends CodexQuotaWindowCandidate>(
  windows: readonly T[],
): T[] {
  const accountWide = windows.filter(
    (window) => window.limitId === undefined || window.limitId === "codex",
  );
  const explicit = accountWide.filter(
    (window) =>
      window.windowMinutes != null &&
      Number.isFinite(window.windowMinutes) &&
      window.windowMinutes >= 7 * 24 * 60,
  );
  if (explicit.length > 0) return explicit;
  return accountWide.filter(
    (window) =>
      window.key === "secondary" &&
      window.windowMinutes == null &&
      Number.isFinite(window.usedPercent) &&
      window.usedPercent > 0,
  );
}

// Codex account plans do not consistently assign the short and weekly allowances
// to `primary` / `secondary`. Prefer the reported duration and retain `secondary`
// only as a compatibility fallback for older header snapshots without duration.
// Model-scoped limits are deliberately excluded: reset credits target the default
// account-wide allowance, not a single model family.
export function isCodexAccountWeeklyQuotaWindow(
  window: Pick<OAuthQuotaWindow, "key" | "windowMinutes" | "limitId">,
): boolean {
  if (window.limitId !== undefined && window.limitId !== "codex") return false;
  if (window.windowMinutes != null && Number.isFinite(window.windowMinutes)) {
    return window.windowMinutes >= 7 * 24 * 60;
  }
  return window.key === "secondary";
}

// Codex subscription identity copied from the authenticated ChatGPT account.
// Optional fields preserve legacy records and claims that some account types omit.
// This is operator-facing metadata only; no token or secret material is allowed.
export const CodexSubscriptionIdentitySchema = z
  .object({
    email: z.string().optional(),
    chatgptPlanType: z.string().optional(),
    chatgptAccountId: z.string().optional(),
    isFedramp: z.boolean().optional(),
  })
  .strict();

export type CodexSubscriptionIdentity = z.infer<typeof CodexSubscriptionIdentitySchema>;

export const CodexQuotaCreditsSchema = z
  .object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullable(),
  })
  .strict();

export type CodexQuotaCredits = z.infer<typeof CodexQuotaCreditsSchema>;

// Codex workspace spend-control limit normalized for Helm's gateway/Admin wire.
// The upstream amounts are decimal strings and must remain strings to avoid losing
// precision. `remainingPercent` is preserved verbatim; renderers clamp only the bar.
export const CodexIndividualLimitSchema = z
  .object({
    limit: z.string(),
    used: z.string(),
    remainingPercent: z.number(),
    resetsAtMs: z.number().int().nullable(),
  })
  .strict();

export type CodexIndividualLimit = z.infer<typeof CodexIndividualLimitSchema>;

export const CodexAdditionalLimitSchema = z
  .object({
    limitId: z.string(),
    limitName: z.string().nullable(),
  })
  .strict();

export type CodexAdditionalLimit = z.infer<typeof CodexAdditionalLimitSchema>;

export const CodexResetCreditDetailSchema = z
  .object({
    id: z.string(),
    resetType: z.enum(["codexRateLimits", "unknown"]),
    status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
    grantedAt: z.number().int(),
    expiresAt: z.number().int().nullable(),
    title: z.string().nullable(),
    description: z.string().nullable(),
  })
  .strict();

export type CodexResetCreditDetail = z.infer<typeof CodexResetCreditDetailSchema>;

export const CodexRateLimitReachedTypeSchema = z.enum([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

export type CodexRateLimitReachedType = z.infer<typeof CodexRateLimitReachedTypeSchema>;

// The latest snapshot for one account: its windows + when/how it was captured.
// `source` records HOW the snapshot was obtained (anthropic = on-demand usage
// endpoint PULL; xai = Grok website gRPC-Web PULL; codex-headers = response-header
// PUSH) so the UI can show honest
// "as of last request" staleness. `usageLimitedUntilMs` is the AUTO-PARK cooldown:
// the epoch ms until which the account is removed from the scheduling pool because
// it hit its usage/rate limit (null = not limited). It is the runtime twin of the
// windows — the scheduler gates on it; clearing it (the "Reset usage" action) sets
// it back to null. OPTIONAL on the wire (`.default(null)`) so legacy rows + pre-field
// fixtures parse unchanged, exactly like `windowMinutes`.
export const OAuthQuotaSnapshotSchema = z
  .object({
    providerId: z.string(),
    account: z.string(),
    windows: z.array(OAuthQuotaWindowSchema),
    capturedAt: z.number().int(), // epoch ms the snapshot was taken
    source: z.enum(["anthropic", "codex-headers", "codex", "xai"]),
    usageLimitedUntilMs: z.number().int().nullable().default(null),
    // Codex only: how many rate-limit reset credits are available at capture time.
    // Optional because Anthropic has no equivalent and older rows predate this field.
    resetCredits: z.number().int().nonnegative().nullable().optional(),
    // Codex-only live metadata folded onto the Admin quota response. These fields
    // are intentionally optional because persisted snapshots contain only windows,
    // cooldown state, and the reset-credit count used by account-pool scoring.
    identity: CodexSubscriptionIdentitySchema.optional(),
    planType: z.string().nullable().optional(),
    credits: CodexQuotaCreditsSchema.nullable().optional(),
    resetCreditDetails: z.array(CodexResetCreditDetailSchema).nullable().optional(),
    // Codex only: the workspace/member monthly spend-control limit from the live
    // usage PULL. It is not persisted by the quota stores, but may be attached by
    // the Admin route to the returned snapshot.
    individualLimit: CodexIndividualLimitSchema.nullable().optional(),
    additionalLimits: z.array(CodexAdditionalLimitSchema).optional(),
    rateLimitReachedType: CodexRateLimitReachedTypeSchema.nullable().optional(),
  })
  .strict();

export type OAuthQuotaSnapshot = z.infer<typeof OAuthQuotaSnapshotSchema>;

// ── Anthropic usage-endpoint response (GET /api/oauth/usage) ─────────────────

// The (untrusted) shape Anthropic's OAuth usage endpoint returns. Parsed
// fail-open: every window may be absent OR explicitly `null` (the API returns
// `"seven_day_opus": null` on plans without a separate Opus weekly cap), so each
// field is `.nullish()` — a strict `.optional()` would REJECT the null and fail the
// whole parse, leaving the page blank. The SAME applies to the INNER fields: a
// PRESENT window can still carry `"resets_at": null` (e.g. a weekly scoped cap not
// yet touched, so no countdown), so both inner fields are `.nullish()` too — an
// inner `.optional()` would reject that null and drop EVERY window, freezing the
// providers page on a stale snapshot. Older payloads expose fixed top-level
// windows: five_hour / seven_day / seven_day_opus / seven_day_sonnet.
const AnthropicWindowSchema = z
  .object({
    utilization: z.number().nullish(),
    resets_at: z.string().nullish(),
  })
  .loose();

// Current Claude usage payloads also carry a generic `limits[]` list. That list is
// now the authoritative source for scoped model limits (for example Fable) because
// old fixed fields such as `seven_day_sonnet` may be null even when a scoped weekly
// row exists. `percent` is already a 0-100 percentage.
const AnthropicLimitScopeSchema = z
  .object({
    model: z
      .object({
        id: z.string().nullable().optional(),
        display_name: z.string().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    surface: z.unknown().nullable().optional(),
  })
  .loose()
  .nullable()
  .optional();

const AnthropicLimitSchema = z
  .object({
    kind: z.string().optional(),
    group: z.string().optional(),
    percent: z.number().nullish(),
    resets_at: z.string().nullish(),
    scope: AnthropicLimitScopeSchema,
    is_active: z.boolean().optional(),
  })
  .loose();

export const AnthropicOAuthUsageSchema = z
  .object({
    five_hour: AnthropicWindowSchema.nullish(),
    seven_day: AnthropicWindowSchema.nullish(),
    seven_day_opus: AnthropicWindowSchema.nullish(),
    seven_day_sonnet: AnthropicWindowSchema.nullish(),
    limits: z.array(AnthropicLimitSchema).nullish(),
  })
  .loose();

export type AnthropicOAuthUsage = z.infer<typeof AnthropicOAuthUsageSchema>;

// ── Codex usage-endpoint response (GET chatgpt.com/backend-api/wham/usage) ────

// The (untrusted) shape ChatGPT's Codex usage endpoint returns — the same payload
// the Codex CLI's /status display reads (active PULL counterpart of the
// `x-codex-*` header PUSH). Parsed fail-open and `.loose()` throughout: the
// endpoint carries plan, credits, additional limits, reached-type, and reset-credit
// metadata, while unknown fields may appear/vanish without breaking the providers
// page. `reset_at` is epoch SECONDS; `used_percent` is already 0–100.
const CodexRateLimitWindowSchema = z
  .object({
    used_percent: z.number().optional(),
    limit_window_seconds: z.number().optional(),
    reset_after_seconds: z.number().optional(),
    reset_at: z.number().optional(),
  })
  .loose();

const CodexRateLimitStatusSchema = z
  .object({
    allowed: z.boolean().optional(),
    limit_reached: z.boolean().optional(),
    primary_window: CodexRateLimitWindowSchema.nullish(),
    secondary_window: CodexRateLimitWindowSchema.nullish(),
  })
  .loose();

const CodexCreditsSchema = z
  .object({
    has_credits: z.boolean().optional(),
    unlimited: z.boolean().optional(),
    balance: z.string().nullish(),
  })
  .loose();

const CodexSpendControlLimitSchema = z
  .object({
    source: z.string().nullish(),
    limit: z.string().optional(),
    used: z.string().optional(),
    remaining: z.string().optional(),
    used_percent: z.number().optional(),
    remaining_percent: z.number().optional(),
    reset_after_seconds: z.number().optional(),
    reset_at: z.number().optional(),
  })
  .loose();

const CodexSpendControlStatusSchema = z
  .object({
    reached: z.boolean().optional(),
    individual_limit: CodexSpendControlLimitSchema.nullish(),
  })
  .loose();

const CodexAdditionalRateLimitSchema = z
  .object({
    limit_name: z.string().optional(),
    metered_feature: z.string().optional(),
    rate_limit: CodexRateLimitStatusSchema.nullish(),
  })
  .loose();

const CodexRateLimitReachedEnvelopeSchema = z
  .object({
    type: z.string(),
  })
  .loose();

// Rate-limit RESET credits the account holds (the "reset usage limit" grant
// OpenAI surfaces in Codex). `available_count` is how many credits can be
// consumed right now; consuming one immediately restores the rate-limit windows.
// `.loose()` + `.nullish()` like the rest of this file — the field is absent for
// plans without the grant, and must never break the providers page.
const CodexRateLimitResetCreditsSchema = z
  .object({
    available_count: z.number().optional(),
    credits: z
      .array(
        z
          .object({
            id: z.string(),
            reset_type: z.string(),
            status: z.string(),
            granted_at: z.string(),
            expires_at: z.string().nullish(),
            title: z.string().nullish(),
            description: z.string().nullish(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

export const CodexOAuthUsageSchema = z
  .object({
    plan_type: z.string().optional(),
    rate_limit: CodexRateLimitStatusSchema.nullish(),
    credits: CodexCreditsSchema.nullish(),
    spend_control: CodexSpendControlStatusSchema.nullish(),
    additional_rate_limits: z.array(CodexAdditionalRateLimitSchema).nullish(),
    rate_limit_reached_type: CodexRateLimitReachedEnvelopeSchema.nullish(),
    rate_limit_reset_credits: CodexRateLimitResetCreditsSchema.nullish(),
  })
  .loose();

export type CodexOAuthUsage = z.infer<typeof CodexOAuthUsageSchema>;

// ── Codex reset-credit CONSUME response ──────────────────────────────────────
// POST chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume returns the
// redeemed-credit envelope. The Gateway adds the camelCase `outcome`,
// `windowsReset`, and `redeemRequestId` projection for Admin. One shared schema
// validates both stages; the nested upstream `credit` metadata remains ignored.
export const CodexResetResultSchema = z
  .object({
    code: z
      .enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed"])
      .nullable()
      .optional(),
    windows_reset: z.number().default(0),
    // Gateway-normalized Admin response. Optional here because the same schema also
    // parses the upstream snake_case envelope before the Gateway projects it.
    outcome: z.enum(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]).optional(),
    windowsReset: z.number().nullable().optional(),
    redeemRequestId: z.string().optional(),
  })
  .loose();

export type CodexResetResult = z.infer<typeof CodexResetResultSchema>;
