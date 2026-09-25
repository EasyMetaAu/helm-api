import { createHash, randomUUID } from "node:crypto";
import { type ConfigStore, parseAnthropicUsageBody } from "@helm/core";
import {
  ANTHROPIC_RESET_WINDOW_KEYS,
  type AnthropicResetRequest,
  AnthropicResetRequestSchema,
  type AnthropicResetResult,
  type AnthropicResetStatus,
  AnthropicResetStatusSchema,
  usableAnthropicResetGrant,
} from "@helm/shared";
import { z } from "zod";

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
const PROFILE = z.object({ organization: z.object({ uuid: z.uuid() }) });
const USAGE = z.object({ cedar_ember: AnthropicResetStatusSchema });
const OUTCOME = z.object({
  result: z.enum(["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"]),
  grant_id: z.string().optional(),
  cleared: z.array(z.string()).default([]),
});
const ATTEMPT = z.object({
  grantId: z.string(),
  resetsLeft: z.number().int().positive(),
  requestId: z.uuid(),
  pending: z.boolean(),
});
const USAGE_PATH = "/api/oauth/usage?cedar_ember=1&skip_spend=1";
const LEASE_MS = 120_000;

export class AnthropicResetError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 429 | 503 = 409,
  ) {
    super(message);
  }
}

export function createAnthropicResetAccess(deps: {
  config: ConfigStore;
  getClient(account: string): Promise<Request>;
  listAccounts(): Promise<string[]>;
  invalidate(): void;
  now(): number;
}) {
  const keyFor = (org: string) =>
    `oauth.anthropic_reset.v1.${createHash("sha256").update(org).digest("hex")}`;
  async function readAttempt(key: string) {
    const raw = await deps.config.get(`${key}.attempt`);
    return raw === null || raw === "" ? null : ATTEMPT.parse(JSON.parse(raw));
  }
  async function readUsage(request: Request, key: string) {
    const body = await request(USAGE_PATH);
    const status = USAGE.parse(body).cedar_ember;
    const attempt = await readAttempt(key);
    // A reduced counter is authoritative evidence that the prior attempt's credit
    // is no longer available. Otherwise an uncertain attempt remains fail-closed.
    const grant = status.grants.find((g) => g.id === attempt?.grantId);
    status.pending = !!attempt?.pending && (!grant || grant.resets_left >= attempt.resetsLeft);
    return { status, windows: parseAnthropicUsageBody(body, deps.now()) };
  }
  async function context(account: string) {
    const request = await deps.getClient(account);
    const org = PROFILE.parse(await request("/api/oauth/profile")).organization.uuid;
    return { request, org, key: keyFor(org) };
  }
  return {
    async getAnthropicResetStatus({ account }: { account: string }): Promise<AnthropicResetStatus> {
      const { request, key } = await context(account);
      return (await readUsage(request, key)).status;
    },
    async consumeAnthropicReset(
      raw: AnthropicResetRequest,
    ): Promise<AnthropicResetResult & { affectedAccounts: string[] }> {
      const input = AnthropicResetRequestSchema.parse(raw);
      const { request, org, key } = await context(input.account);
      const reserve = deps.config.setIfMissingOrNumericLte?.bind(deps.config);
      if (!reserve) throw new AnthropicResetError("Reset guard is unavailable", 503);
      const lease = deps.now() + LEASE_MS;
      if (!(await reserve(`${key}.lease`, String(lease), deps.now()))) {
        throw new AnthropicResetError(
          "A reset is already in progress for this Claude organization",
          429,
        );
      }
      try {
        const before = await readUsage(request, key);
        if (before.status.pending)
          throw new AnthropicResetError(
            "Previous reset is unconfirmed; refresh Claude usage before trying again",
          );
        const grant = usableAnthropicResetGrant(before.status, deps.now());
        if (
          !grant ||
          grant.id !== input.grantId ||
          grant.resets_left !== input.expectedResetsLeft
        ) {
          throw new AnthropicResetError(
            "Reset grant changed or is unavailable; refresh and confirm again",
          );
        }
        const attempt = {
          grantId: grant.id,
          resetsLeft: grant.resets_left,
          requestId: randomUUID(),
          pending: true,
        };
        // Persist before dispatch: a crash or unreadable response must never create
        // another spend under a new request id after restart.
        await deps.config.set(`${key}.attempt`, JSON.stringify(attempt));
        let outcome: z.infer<typeof OUTCOME> | null = null;
        try {
          const body = await request(`/api/organizations/${org}/reset_rate_limits`, {
            method: "POST",
            body: JSON.stringify({
              program: "cedar_ember",
              grant_id: grant.id,
              request_id: attempt.requestId,
            }),
          });
          const parsed = OUTCOME.safeParse(body);
          if (parsed.success && (!parsed.data.grant_id || parsed.data.grant_id === grant.id))
            outcome = parsed.data;
        } catch {
          /* unknown outcome: read back, never automatically replay POST */
        }
        deps.invalidate();
        const after = await readUsage(request, key).catch(() => null);
        const remaining = after?.status.grants.find((g) => g.id === grant.id)?.resets_left;
        const reduced = remaining !== undefined && remaining < grant.resets_left;
        const scope = outcome?.result === "reset" ? outcome.cleared : grant.clears;
        const windowsRestored =
          scope.length > 0 &&
          scope.every((name) => {
            const k = ANTHROPIC_RESET_WINDOW_KEYS[name];
            const prev = before.windows.find((w) => w.key === k);
            const next = after?.windows.find((w) => w.key === k);
            return (
              next !== undefined &&
              next.usedPercent < 100 &&
              (outcome?.result === "reset" ||
                (prev !== undefined &&
                  (prev.usedPercent === 0 || next.usedPercent < prev.usedPercent)))
            );
          });
        const confirmed = reduced && windowsRestored;
        const definitiveNoReset =
          outcome && ["not_limited", "cooldown", "ineligible"].includes(outcome.result);
        attempt.pending = !confirmed && !definitiveNoReset;
        await deps.config.set(`${key}.attempt`, JSON.stringify(attempt));
        if (after) after.status.pending = attempt.pending;
        const result = confirmed
          ? "reset"
          : outcome?.result === "already_used" && reduced
            ? "already_used"
            : definitiveNoReset
              ? (outcome?.result ?? "unknown")
              : "unknown";
        const affectedAccounts = [input.account];
        let identitiesComplete = true;
        if (confirmed) {
          // Alias labels can hold different tokens for the same organization.
          for (const account of await deps.listAccounts()) {
            if (account === input.account) continue;
            try {
              const sibling = await context(account);
              if (sibling.org === org) {
                const siblingRead = await readUsage(sibling.request, key);
                if (!siblingRead.status.pending) affectedAccounts.push(account);
                else identitiesComplete = false;
              }
            } catch {
              identitiesComplete = false;
            }
          }
          if (identitiesComplete) deps.invalidate();
        }
        return {
          result,
          status: after?.status ?? null,
          quotaRefreshed: identitiesComplete && confirmed,
          affectedAccounts,
        };
      } finally {
        await reserve(`${key}.lease`, "0", lease);
      }
    },
  };
}
