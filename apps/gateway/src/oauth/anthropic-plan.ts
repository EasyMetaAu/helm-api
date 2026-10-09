import { createHash } from "node:crypto";
import type { ConfigStore } from "@helm/core";
import { type AnthropicPlanType, AnthropicPlanTypeSchema } from "@helm/shared";
import { z } from "zod";

const PROFILE = z.object({ organization: z.object({ organization_type: z.string() }) });
const CACHE = z.object({
  binding: z.string(),
  plan: AnthropicPlanTypeSchema.nullable(),
  checkedAt: z.number().finite().nonnegative(),
});
const REFRESH_TTL_MS = 300_000;
const UNKNOWN = { plan: null, checkedAt: null };

export function parseAnthropicPlan(body: unknown): AnthropicPlanType | null {
  const profile = PROFILE.safeParse(body);
  if (!profile.success) return null;
  const plans: Record<string, AnthropicPlanType> = {
    claude_pro: "pro",
    claude_max: "max",
    claude_team: "team",
    claude_enterprise: "enterprise",
  };
  const plan = AnthropicPlanTypeSchema.safeParse(
    plans[profile.data.organization.organization_type],
  );
  return plan.success ? plan.data : null;
}

// Display metadata only: no raw profile, identity UUID or credential is persisted.
// Cached reads remain offline; checkedAt makes the age of the last observation explicit.
export function createAnthropicPlanAccess(deps: {
  config: ConfigStore;
  binding(account: string): Promise<string | null>;
  fetchProfile(account: string): Promise<unknown>;
  now(): number;
}) {
  const pending = new Map<
    string,
    Promise<{ plan: AnthropicPlanType | null; checkedAt: number | null }>
  >();
  async function load(account: string, refresh: boolean, force: boolean) {
    try {
      const binding = await deps.binding(account);
      if (!binding) return UNKNOWN;
      const key = `oauth.anthropic_plan.v1.${createHash("sha256").update(account).digest("hex")}`;
      const raw = await deps.config.get(key);
      let cached: z.infer<typeof CACHE> | null = null;
      try {
        const parsed = CACHE.safeParse(raw ? JSON.parse(raw) : null);
        if (parsed.success && parsed.data.binding === binding) cached = parsed.data;
      } catch {
        /* A corrupt display cache must not break account management. */
      }
      if (!refresh || (!force && cached && deps.now() - cached.checkedAt < REFRESH_TTL_MS)) {
        return cached ? { plan: cached.plan, checkedAt: cached.checkedAt } : UNKNOWN;
      }
      let plan: AnthropicPlanType | null = null;
      try {
        plan = parseAnthropicPlan(await deps.fetchProfile(account));
      } catch {
        /* Unknown, never infer from limits. */
      }
      if ((await deps.binding(account)) !== binding) return UNKNOWN;
      const checkedAt = deps.now();
      await deps.config.set(key, JSON.stringify({ binding, plan, checkedAt }));
      return { plan, checkedAt };
    } catch {
      return UNKNOWN;
    }
  }
  return {
    async get(account: string, refresh: boolean, force: boolean) {
      if (!refresh) return load(account, false, false);
      const existing = pending.get(account);
      if (existing) return existing;
      const result = load(account, true, force).finally(() => pending.delete(account));
      pending.set(account, result);
      return result;
    },
  };
}
