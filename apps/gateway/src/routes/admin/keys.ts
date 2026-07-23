import { CreateKeyRequestSchema, StatsQuerySchema, UpdateKeyRequestSchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import { INTERNAL_API_KEY_ID } from "../../internal-key.js";
import type { AdminApiDeps, KeySummary, KeyUsageSummary } from "./deps.js";
import { adminWindowCacheKey, createAdminReadCache } from "./read-cache.js";

// Default usage window for the list column when start is omitted: today in the
// viewer's local day. The SPA sends an explicit local-midnight start; this fallback
// covers direct API calls and stale clients.
const DAY_MS = 86_400_000;

function localDayStartMs(nowMs: number, tzOffsetMinutes: number): number {
  const offsetMs = tzOffsetMinutes * 60_000;
  return nowMs + offsetMs - ((nowMs + offsetMs) % DAY_MS) - offsetMs;
}

// /admin/api/keys — manage API keys (KeyStore, NEVER yaml). Plaintext is minted
// here and returned only to the authenticated admin surface. New/rotated rows may
// store AES-GCM ciphertext for later admin reveal, but list/detail responses still
// project to a redacted KeySummary — no hash full-text, no plaintext, no ciphertext.
// Revocation is a soft disable (disabled:true). Rotation updates only hash/prefix/
// ciphertext on the SAME key_id, preserving metadata and history. A physical delete
// is offered only as an explicit second step (DELETE ?purge=true) on an already
// revoked key, so destruction is deliberate and the soft-revoke audit step remains.

// Redact a stored record to the summary the list view exposes. Deliberately omits
// `hash` and `account_id` internals beyond what the UI needs; NEVER plaintext.
function toSummary(rec: {
  key_id: string;
  prefix: string;
  role: "root" | "user";
  name: string | null;
  allowed_lanes: string[] | null;
  allow_custom_model: boolean;
  blocked_models: string[] | null;
  allow_fast_mode: boolean;
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
    name: rec.name,
    allowed_lanes: rec.allowed_lanes,
    allow_custom_model: rec.allow_custom_model,
    blocked_models: rec.blocked_models,
    allow_fast_mode: rec.allow_fast_mode,
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
  const usageCache = createAdminReadCache<KeyUsageSummary[]>({
    ...(deps.runInBackground !== undefined ? { runInBackground: deps.runInBackground } : {}),
  });
  // GET /keys -> KeySummary[] (no plaintext, no hash full-text).
  app.get("/admin/api/keys", async (c) => {
    const rows = await deps.keyStore.list();
    return c.json(rows.map(toSummary));
  });

  // GET /keys/usage?start&end -> KeyUsageSummary[] — per-key usage rollup for the
  // list "Usage" column (ONE GROUP BY in the store, never one-per-key). MUST be
  // registered BEFORE /keys/:id or Hono would match "usage" as an :id. The window
  // is parsed with the SAME fail-open schema as /stats. `start`/`end` are the
  // half-open window; when start is omitted, `tzOffsetMinutes` lets the fallback
  // mean the viewer's local "today" instead of a rolling 24h window.
  app.get("/admin/api/keys/usage", async (c) => {
    const q = StatsQuerySchema.parse(c.req.query());
    const now = Date.now();
    const end = q.end ?? now;
    const start = q.start ?? localDayStartMs(end, q.tzOffsetMinutes);
    const key = adminWindowCacheKey({
      start,
      end,
      now,
      // The route's fallback is local calendar midnight, not a rolling duration;
      // keep that absolute start in the key so repeated default reads can hit.
      startWasDefault: false,
      endWasDefault: q.end === undefined,
      dimensions: [q.tzOffsetMinutes],
    });
    const result = await usageCache.get(key, async () => {
      const usage = await deps.telemetry.usageByKey(start, end);
      return usage.map(
        (u): KeyUsageSummary => ({
          key_id: u.apiKeyId,
          requests: u.requests,
          error_count: u.errorCount,
          cost_usd: u.totalCostUsd,
          total_tokens: u.totalTokens,
        }),
      );
    });
    c.header("X-Helm-Cache", result.status);
    return c.json(result.value);
  });

  // GET /keys/:id/secret -> reveal the full key when this row has encrypted
  // recovery material. Old hash-only rows cannot be recovered by design.
  app.get("/admin/api/keys/:id/secret", async (c) => {
    if (!deps.keySecrets) {
      return c.json({ error: "key reveal is not configured" }, 503);
    }
    const id = c.req.param("id");
    if (id === INTERNAL_API_KEY_ID) {
      return c.json({ error: "internal system key cannot be revealed" }, 403);
    }
    let secretEnc: string | null;
    try {
      secretEnc = await deps.keyStore.getSecretEnc(id);
    } catch {
      return c.json({ error: "key not found" }, 404);
    }
    if (!secretEnc) {
      return c.json(
        {
          error:
            "full key is not available for this row; rotate it to store recoverable key material",
        },
        409,
      );
    }
    try {
      return c.json({ key_id: id, plaintext: deps.keySecrets.decrypt(secretEnc) });
    } catch {
      return c.json({ error: "stored key cannot be decrypted with the current key" }, 500);
    }
  });

  // POST /keys/:id/rotate -> rotate the secret value in-place. The old plaintext
  // stops authenticating immediately because the hash changes, but key_id, name,
  // caps, account, role, telemetry, and usage history are preserved.
  app.post("/admin/api/keys/:id/rotate", async (c) => {
    const id = c.req.param("id");
    if (id === INTERNAL_API_KEY_ID) {
      return c.json({ error: "internal system key cannot be rotated" }, 403);
    }
    const existing = (await deps.keyStore.list()).find((r) => r.key_id === id);
    if (!existing) return c.json({ error: "key not found" }, 404);
    if (existing.disabled) return c.json({ error: "revoked keys cannot be rotated" }, 409);
    const minted = deps.genKey();
    const secretEnc = deps.keySecrets ? deps.keySecrets.encrypt(minted.plaintext) : null;
    try {
      await deps.keyStore.rotateKey(id, {
        hash: minted.hash,
        prefix: minted.prefix,
        secretEnc,
      });
    } catch {
      return c.json({ error: "key not found" }, 404);
    }
    return c.json({
      key_id: id,
      plaintext: minted.plaintext,
      prefix: minted.prefix,
      recoverable: secretEnc !== null,
    });
  });

  // GET /keys/:id -> the full redacted record (KeySummary) | 404. The detail page
  // reads every per-key cap to render its config card; we reuse the list's
  // redaction (prefix only — NEVER hash/plaintext, principle 7). list().find
  // mirrors the DELETE purge path (KeyStore has no get-by-id; the admin list is small).
  app.get("/admin/api/keys/:id", async (c) => {
    const id = c.req.param("id");
    const rec = (await deps.keyStore.list()).find((r) => r.key_id === id);
    if (!rec) return c.json({ error: "key not found" }, 404);
    return c.json(toSummary(rec));
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
      secretEnc: deps.keySecrets ? deps.keySecrets.encrypt(minted.plaintext) : null,
      accountId: deps.accountId,
      role: parsed.data.role,
      name: parsed.data.name,
      allowedLanes: parsed.data.allowed_lanes,
      allowCustomModel: parsed.data.allow_custom_model ?? false,
      blockedModels: parsed.data.blocked_models,
      allowFastMode: parsed.data.allow_fast_mode ?? false,
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
    return c.json(
      {
        key_id: keyId,
        plaintext: minted.plaintext,
        prefix: minted.prefix,
        recoverable: deps.keySecrets !== undefined,
      },
      201,
    );
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
      name?: string | null;
      allowedLanes?: string[] | null;
      allowCustomModel?: boolean;
      blockedModels?: string[] | null;
      allowFastMode?: boolean;
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
    if (d.name !== undefined) patch.name = d.name;
    if (d.allowed_lanes !== undefined) patch.allowedLanes = d.allowed_lanes;
    if (d.allow_custom_model !== undefined) patch.allowCustomModel = d.allow_custom_model;
    if (d.blocked_models !== undefined) patch.blockedModels = d.blocked_models;
    if (d.allow_fast_mode !== undefined) patch.allowFastMode = d.allow_fast_mode;
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

  // DELETE /keys/:id — soft revoke (disabled:true) by default. 404 when the id is
  // unknown. With ?purge=true it instead PERMANENTLY deletes the row — but only a
  // key that has ALREADY been revoked: a two-step destroy so an active key is
  // never silently wiped (409 if still active). Audit history survives — telemetry
  // references key_id as an unlinked column (docs/06).
  app.delete("/admin/api/keys/:id", async (c) => {
    const id = c.req.param("id");
    // The auto-minted internal LLM key is system-managed (re-minted each startup) and
    // backs the internal memory/eval self-HTTP calls. Revoking or deleting it would
    // silently break those calls (they fail-open to the deterministic stub) until the
    // next restart — so refuse both the soft-revoke and the purge paths.
    if (id === INTERNAL_API_KEY_ID) {
      return c.json({ error: "internal system key cannot be revoked or deleted" }, 403);
    }
    if (c.req.query("purge") === "true") {
      // Gate on the current state: must exist AND be revoked first.
      const existing = (await deps.keyStore.list()).find((r) => r.key_id === id);
      if (!existing) return c.json({ error: "key not found" }, 404);
      if (!existing.disabled) {
        return c.json({ error: "key must be revoked before deletion" }, 409);
      }
      try {
        await deps.keyStore.deleteKey(id);
      } catch {
        // Lost a race — the row vanished between the read and the delete.
        return c.json({ error: "key not found" }, 404);
      }
      return c.json({ deleted: id });
    }
    try {
      await deps.keyStore.disable(id);
    } catch {
      return c.json({ error: "key not found" }, 404);
    }
    return c.json({ revoked: id });
  });
}
