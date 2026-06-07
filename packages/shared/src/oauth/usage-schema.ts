import { z } from "zod";

// Per-account OAuth subscription USAGE + QUOTA observability (providers-page
// enrichment). These are OBSERVABILITY artifacts, never a security boundary, so
// every read/write path is FAIL-OPEN: a malformed row / upstream payload must
// never 5xx a chat request nor break the admin page (CLAUDE.md Principle 3).
// Single source of truth via z.infer.

// ── Usage (Tier 2): today's served traffic per (provider, account) ───────────

// One daily aggregate row, keyed by (providerId, account, day). `day` is the
// UTC-midnight epoch-ms the traffic fell on. `requests` counts served calls;
// `tokens` is the total served tokens (prompt+completion, summed across calls);
// `costUsd` is the summed completion cost — NULLABLE because subscription plans
// are flat-rate (no per-token price), so null = "unpriced", distinct from a
// measured 0. `firstSeenMs` anchors the daily-average RPM derivation.
export const OAuthUsageRowSchema = z
  .object({
    providerId: z.string(),
    account: z.string(),
    day: z.number().int(), // UTC-midnight epoch ms
    requests: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costUsd: z.number().nullable(),
    firstSeenMs: z.number().int(), // epoch ms of the day's first served call
    updatedAt: z.number().int(), // epoch ms of the last write
  })
  .strict();

export type OAuthUsageRow = z.infer<typeof OAuthUsageRowSchema>;

// ── Quota (Tier 3): latest rate-limit window snapshot per (provider, account) ─

// One rate-limit window. `key` names the window (Claude: 5h / 7d / 7d-opus /
// 7d-sonnet; Codex: primary / secondary). `usedPercent` is 0–100. `resetsAtMs` is the epoch
// ms the window resets (null when unknown). `windowMinutes` is the window length
// when the provider reports it (Codex), else null.
export const OAuthQuotaWindowSchema = z
  .object({
    key: z.string(),
    usedPercent: z.number().min(0).max(100),
    resetsAtMs: z.number().int().nullable(),
    windowMinutes: z.number().int().positive().nullable().default(null),
  })
  .strict();

export type OAuthQuotaWindow = z.infer<typeof OAuthQuotaWindowSchema>;

// The latest snapshot for one account: its windows + when/how it was captured.
// `source` records HOW the snapshot was obtained (anthropic = on-demand usage
// endpoint PULL; codex-headers = response-header PUSH) so the UI can show honest
// "as of last request" staleness.
export const OAuthQuotaSnapshotSchema = z
  .object({
    providerId: z.string(),
    account: z.string(),
    windows: z.array(OAuthQuotaWindowSchema),
    capturedAt: z.number().int(), // epoch ms the snapshot was taken
    source: z.enum(["anthropic", "codex-headers", "codex"]),
  })
  .strict();

export type OAuthQuotaSnapshot = z.infer<typeof OAuthQuotaSnapshotSchema>;

// ── Anthropic usage-endpoint response (GET /api/oauth/usage) ─────────────────

// The (untrusted) shape Anthropic's OAuth usage endpoint returns. Parsed
// fail-open: every window may be absent OR explicitly `null` (the API returns
// `"seven_day_opus": null` on plans without a separate Opus weekly cap), so each
// field is `.nullish()` — a strict `.optional()` would REJECT the null and fail the
// whole parse, leaving the page blank. The SAME applies to the INNER fields: a
// PRESENT window can still carry `"resets_at": null` (e.g. a weekly Sonnet cap not
// yet touched, so no countdown), so both inner fields are `.nullish()` too — an
// inner `.optional()` would reject that null and drop EVERY window, freezing the
// providers page on a stale snapshot. `utilization` is already a 0–100 PERCENT
// (e.g. 33.0), NOT a 0–1 fraction — do not re-scale on ingest. `resets_at` is an
// ISO-8601 timestamp. Windows: five_hour / seven_day / seven_day_opus /
// seven_day_sonnet (mirrors the official Claude /usage display).
const AnthropicWindowSchema = z
  .object({
    utilization: z.number().nullish(),
    resets_at: z.string().nullish(),
  })
  .loose();

export const AnthropicOAuthUsageSchema = z
  .object({
    five_hour: AnthropicWindowSchema.nullish(),
    seven_day: AnthropicWindowSchema.nullish(),
    seven_day_opus: AnthropicWindowSchema.nullish(),
    seven_day_sonnet: AnthropicWindowSchema.nullish(),
  })
  .loose();

export type AnthropicOAuthUsage = z.infer<typeof AnthropicOAuthUsageSchema>;

// ── Codex usage-endpoint response (GET chatgpt.com/backend-api/wham/usage) ────

// The (untrusted) shape ChatGPT's Codex usage endpoint returns — the same payload
// the Codex CLI's /status display reads (active PULL counterpart of the
// `x-codex-*` header PUSH). Parsed fail-open and `.loose()` throughout: the
// endpoint also carries plan/credits/additional_rate_limits fields we ignore, and
// any of them may appear/vanish without breaking the providers page. `reset_at`
// is epoch SECONDS; `used_percent` is already 0–100.
const CodexRateLimitWindowSchema = z
  .object({
    used_percent: z.number().optional(),
    limit_window_seconds: z.number().optional(),
    reset_after_seconds: z.number().optional(),
    reset_at: z.number().optional(),
  })
  .loose();

export const CodexOAuthUsageSchema = z
  .object({
    rate_limit: z
      .object({
        primary_window: CodexRateLimitWindowSchema.nullish(),
        secondary_window: CodexRateLimitWindowSchema.nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export type CodexOAuthUsage = z.infer<typeof CodexOAuthUsageSchema>;
