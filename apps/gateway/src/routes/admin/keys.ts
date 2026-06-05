import { CreateKeyRequestSchema, UpdateKeyRequestSchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps, KeySummary } from "./deps.js";

// /admin/api/keys — manage API keys (KeyStore, NEVER yaml). CLAUDE.md Principle 7: keys
// are stored as sha256 hash + display prefix ONLY. The plaintext is minted here,
// returned EXACTLY ONCE in the POST response, and never persisted or echoed again.
// The list view projects to a redacted KeySummary — no hash full-text, no plaintext.
// Revocation is a soft disable (disabled:true), never a physical delete or in-place
// rewrite (docs/06 key rotation/revocation).

// Redact a stored record to the summary the list view exposes. Deliberately omits
// `hash` and `account_id` internals beyond what the UI needs; NEVER plaintext.
function toSummary(rec: {
  key_id: string;
  prefix: string;
  role: "root" | "user";
  allowed_lanes: string[] | null;
  allow_custom_model: boolean;
  disabled: boolean;
  rate_limit_rpm: number | null;
  rate_limit_tpm: number | null;
  budget_requests: number | null;
  budget_tokens: number | null;
  budget_spend_usd: number | null;
  budget_window_seconds: number | null;
  over_budget_behavior: "degrade" | "reject";
  degrade_lane: string | null;
  concurrency_limit: number | null;
  memory_mode: "off" | "observe" | "inject";
  memory_project_id: string | null;
  memory_thread_source: "header" | "auto";
}): KeySummary {
  return {
    key_id: rec.key_id,
    prefix: rec.prefix,
    role: rec.role,
    allowed_lanes: rec.allowed_lanes,
    allow_custom_model: rec.allow_custom_model,
    disabled: rec.disabled,
    rate_limit_rpm: rec.rate_limit_rpm,
    rate_limit_tpm: rec.rate_limit_tpm,
    budget_requests: rec.budget_requests,
    budget_tokens: rec.budget_tokens,
    budget_spend_usd: rec.budget_spend_usd,
    budget_window_seconds: rec.budget_window_seconds,
    over_budget_behavior: rec.over_budget_behavior,
    degrade_lane: rec.degrade_lane,
    concurrency_limit: rec.concurrency_limit,
    memory_mode: rec.memory_mode,
    memory_project_id: rec.memory_project_id,
    memory_thread_source: rec.memory_thread_source,
  };
}

export function registerKeysRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /keys -> KeySummary[] (no plaintext, no hash full-text).
  app.get("/admin/api/keys", async (c) => {
    const rows = await deps.keyStore.list();
    return c.json(rows.map(toSummary));
  });

  // POST /keys -> { key_id, plaintext } (plaintext returned ONCE).
  app.post("/admin/api/keys", async (c) => {
    const parsed = CreateKeyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid key request", issues: parsed.error.issues }, 400);
    }
    const minted = deps.genKey();
    const keyId = deps.genKeyId();
    await deps.keyStore.createKey({
      keyId,
      hash: minted.hash,
      prefix: minted.prefix,
      accountId: deps.accountId,
      role: parsed.data.role,
      allowedLanes: parsed.data.allowed_lanes,
      allowCustomModel: parsed.data.allow_custom_model ?? false,
      rateLimitRpm: parsed.data.rate_limit_rpm,
      rateLimitTpm: parsed.data.rate_limit_tpm,
      budgetRequests: parsed.data.budget_requests,
      budgetTokens: parsed.data.budget_tokens,
      budgetSpendUsd: parsed.data.budget_spend_usd,
      budgetWindowSeconds: parsed.data.budget_window_seconds,
      overBudgetBehavior: parsed.data.over_budget_behavior,
      degradeLane: parsed.data.degrade_lane,
      concurrencyLimit: parsed.data.concurrency_limit,
      memoryMode: parsed.data.memory_mode,
      memoryProjectId: parsed.data.memory_project_id,
      memoryThreadSource: parsed.data.memory_thread_source,
    });
    // The ONLY place plaintext is ever returned. `prefix` is the server-minted
    // non-sensitive display prefix (already persisted) — returned so the SPA need
    // not slice the plaintext to build a redacted view (a redaction footgun).
    return c.json({ key_id: keyId, plaintext: minted.plaintext, prefix: minted.prefix }, 201);
  });

  // PATCH /keys/:id — edit a key's per-key caps (docs/06). Every cap is editable
  // after mint EXCEPT the immutable identity and `role` (role stays fixed so the
  // edit path can't escalate a user key to root; rotate role by revoke + re-mint —
  // the schema rejects a role field). The body is validated with .strict() so an
  // unknown field is rejected (400, fail-closed). The patch is PARTIAL: an omitted
  // field is left untouched at the store layer (no read-modify-write, so
  // concurrent partial PATCHes can't clobber each other); an explicit null clears
  // a cap (rate limit → inherit the system default; allowed_lanes → no
  // whitelist). 404 on unknown id.
  app.patch("/admin/api/keys/:id", async (c) => {
    const parsed = UpdateKeyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid key update", issues: parsed.error.issues }, 400);
    }
    const id = c.req.param("id");
    // Forward ONLY the fields the client supplied (present, possibly null), mapping
    // the wire snake_case to the store's camelCase KeyPatch. Zod leaves an omitted
    // field as `undefined`, distinguishing "clear" (null) from "leave unchanged".
    const d = parsed.data;
    const patch: {
      allowedLanes?: string[] | null;
      allowCustomModel?: boolean;
      rateLimitRpm?: number | null;
      rateLimitTpm?: number | null;
      budgetRequests?: number | null;
      budgetTokens?: number | null;
      budgetSpendUsd?: number | null;
      budgetWindowSeconds?: number | null;
      overBudgetBehavior?: "degrade" | "reject";
      degradeLane?: string | null;
      concurrencyLimit?: number | null;
      memoryMode?: "off" | "observe" | "inject";
      memoryProjectId?: string | null;
      memoryThreadSource?: "header" | "auto";
    } = {};
    if (d.allowed_lanes !== undefined) patch.allowedLanes = d.allowed_lanes;
    if (d.allow_custom_model !== undefined) patch.allowCustomModel = d.allow_custom_model;
    if (d.rate_limit_rpm !== undefined) patch.rateLimitRpm = d.rate_limit_rpm;
    if (d.rate_limit_tpm !== undefined) patch.rateLimitTpm = d.rate_limit_tpm;
    if (d.budget_requests !== undefined) patch.budgetRequests = d.budget_requests;
    if (d.budget_tokens !== undefined) patch.budgetTokens = d.budget_tokens;
    if (d.budget_spend_usd !== undefined) patch.budgetSpendUsd = d.budget_spend_usd;
    if (d.budget_window_seconds !== undefined) patch.budgetWindowSeconds = d.budget_window_seconds;
    if (d.over_budget_behavior !== undefined) patch.overBudgetBehavior = d.over_budget_behavior;
    if (d.degrade_lane !== undefined) patch.degradeLane = d.degrade_lane;
    if (d.concurrency_limit !== undefined) patch.concurrencyLimit = d.concurrency_limit;
    if (d.memory_mode !== undefined) patch.memoryMode = d.memory_mode;
    if (d.memory_project_id !== undefined) patch.memoryProjectId = d.memory_project_id;
    if (d.memory_thread_source !== undefined) patch.memoryThreadSource = d.memory_thread_source;
    try {
      await deps.keyStore.updateKey(id, patch);
    } catch {
      return c.json({ error: "key not found" }, 404);
    }
    return c.json({ key_id: id, ...d });
  });

  // DELETE /keys/:id — soft revoke (disabled:true). 404 when the id is unknown.
  app.delete("/admin/api/keys/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await deps.keyStore.disable(id);
    } catch {
      return c.json({ error: "key not found" }, 404);
    }
    return c.json({ revoked: id });
  });
}
