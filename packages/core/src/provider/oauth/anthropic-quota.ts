import {
  type AnthropicOAuthUsage,
  AnthropicOAuthUsageSchema,
  type OAuthQuotaWindow,
} from "@helm/shared";

// Map Anthropic's OAuth usage-endpoint payload (GET /api/oauth/usage) to the
// providers-page quota windows (Tier 3). Anthropic reports percentages as 0-100
// (e.g. 33.0), NOT 0-1 fractions — surfaced as-is (clamped), never re-scaled.
// Prefer the current generic `limits[]` shape because scoped model caps now appear
// there (Fable) while old fixed fields may be null. Fall back to legacy top-level
// windows for older payloads. PURE + FAIL-OPEN: an absent window or unparseable
// reset timestamp is skipped/nulled, never thrown.
const LEGACY_WINDOWS = [
  { src: "five_hour", key: "5h" },
  { src: "seven_day", key: "7d" },
  { src: "seven_day_opus", key: "7d-opus" },
  { src: "seven_day_sonnet", key: "7d-sonnet" },
] as const;

type AnthropicLimit = NonNullable<AnthropicOAuthUsage["limits"]>[number];

function parseResetMs(raw: unknown): number | null {
  const resetMs = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(resetMs) ? resetMs : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function modelSlug(limit: AnthropicLimit): string {
  const displayName = limit.scope?.model?.display_name;
  const raw = typeof displayName === "string" && displayName.trim() !== "" ? displayName : "scoped";
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "scoped";
}

function windowFromLimit(limit: AnthropicLimit): OAuthQuotaWindow | null {
  if (typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) return null;

  let key: string | null = null;
  if (limit.kind === "session" || limit.group === "session") {
    key = "5h";
  } else if (limit.kind === "weekly_all") {
    key = "7d";
  } else if (limit.kind === "weekly_scoped") {
    key = `7d-${modelSlug(limit)}`;
  }
  if (key === null) return null;

  return {
    key,
    usedPercent: clampPercent(limit.percent),
    resetsAtMs: parseResetMs(limit.resets_at),
    windowMinutes: null,
  };
}

function windowsFromLimits(usage: AnthropicOAuthUsage): OAuthQuotaWindow[] {
  const windows = usage.limits?.map(windowFromLimit).filter((w) => w !== null) ?? [];
  const seen = new Set<string>();
  return windows.filter((w) => {
    if (seen.has(w.key)) return false;
    seen.add(w.key);
    return true;
  });
}

export function anthropicUsageToWindows(
  usage: AnthropicOAuthUsage,
  _nowMs: number,
): OAuthQuotaWindow[] {
  const out: OAuthQuotaWindow[] = [];
  const seen = new Set<string>();
  for (const w of windowsFromLimits(usage)) {
    out.push(w);
    seen.add(w.key);
  }

  for (const w of LEGACY_WINDOWS) {
    if (seen.has(w.key)) continue;
    const win = (usage as Record<string, { utilization?: number; resets_at?: string } | undefined>)[
      w.src
    ];
    if (!win || typeof win.utilization !== "number" || !Number.isFinite(win.utilization)) continue;
    out.push({
      key: w.key,
      usedPercent: clampPercent(win.utilization),
      resetsAtMs: parseResetMs(win.resets_at),
      windowMinutes: null, // Anthropic does not report a window length
    });
  }
  return out;
}

// Parse a raw (untrusted) usage-endpoint body into windows. Returns [] on any Zod
// failure (fail-open — a malformed body must never break the providers page).
export function parseAnthropicUsageBody(body: unknown, nowMs: number): OAuthQuotaWindow[] {
  const parsed = AnthropicOAuthUsageSchema.safeParse(body);
  if (!parsed.success) return [];
  return anthropicUsageToWindows(parsed.data, nowMs);
}
