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
  max_lane: string | null;
  allowed_lanes: string[] | null;
  allow_custom_model: boolean;
  disabled: boolean;
  rate_limit_rpm: number | null;
  rate_limit_tpm: number | null;
}): KeySummary {
  return {
    key_id: rec.key_id,
    prefix: rec.prefix,
    role: rec.role,
    max_lane: rec.max_lane,
    allowed_lanes: rec.allowed_lanes,
    allow_custom_model: rec.allow_custom_model,
    disabled: rec.disabled,
    rate_limit_rpm: rec.rate_limit_rpm,
    rate_limit_tpm: rec.rate_limit_tpm,
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
      maxLane: parsed.data.max_lane,
      allowedLanes: parsed.data.allowed_lanes,
      allowCustomModel: parsed.data.allow_custom_model ?? false,
      rateLimitRpm: parsed.data.rate_limit_rpm,
      rateLimitTpm: parsed.data.rate_limit_tpm,
    });
    // The ONLY place plaintext is ever returned. `prefix` is the server-minted
    // non-sensitive display prefix (already persisted) — returned so the SPA need
    // not slice the plaintext to build a redacted view (a redaction footgun).
    return c.json({ key_id: keyId, plaintext: minted.plaintext, prefix: minted.prefix }, 201);
  });

  // PATCH /keys/:id — edit a key's per-key rate-limit override (docs/06). Only the
  // two rate-limit dimensions are editable after mint (role/caps are fixed; rotate
  // by revoking + re-minting). The body is validated with .strict() so an unknown
  // field is rejected (400, fail-closed). The patch is PARTIAL: an omitted
  // dimension is left untouched at the store layer (no read-modify-write, so
  // concurrent partial PATCHes can't clobber each other); an explicit null clears
  // the override back to inheriting the system default; a number (0 = unlimited)
  // sets an explicit override. 404 on unknown id.
  app.patch("/admin/api/keys/:id", async (c) => {
    const parsed = UpdateKeyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid key update", issues: parsed.error.issues }, 400);
    }
    const id = c.req.param("id");
    // Forward ONLY the dimensions the client supplied (present, possibly null).
    // Zod leaves an omitted field as `undefined`, so this distinguishes
    // "clear to inherit" (null) from "leave unchanged" (absent).
    const patch: { rpm?: number | null; tpm?: number | null } = {};
    if (parsed.data.rate_limit_rpm !== undefined) patch.rpm = parsed.data.rate_limit_rpm;
    if (parsed.data.rate_limit_tpm !== undefined) patch.tpm = parsed.data.rate_limit_tpm;
    try {
      await deps.keyStore.updateRateLimit(id, patch);
    } catch {
      return c.json({ error: "key not found" }, 404);
    }
    return c.json({ key_id: id, ...parsed.data });
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
