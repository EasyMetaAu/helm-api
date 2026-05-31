import { CreateKeyRequestSchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps, KeySummary } from "./deps.js";

// /admin/api/keys — manage API keys (KeyStore, NEVER yaml). CLAUDE.md 原则7: keys
// are stored as sha256 hash + display prefix ONLY. The plaintext is minted here,
// returned EXACTLY ONCE in the POST response, and never persisted or echoed again.
// The list view projects to a redacted KeySummary — no hash full-text, no plaintext.
// Revocation is a soft disable (disabled:true), never a physical delete or in-place
// rewrite (docs/06 轮转吊销).

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
}): KeySummary {
  return {
    key_id: rec.key_id,
    prefix: rec.prefix,
    role: rec.role,
    max_lane: rec.max_lane,
    allowed_lanes: rec.allowed_lanes,
    allow_custom_model: rec.allow_custom_model,
    disabled: rec.disabled,
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
    });
    // The ONLY place plaintext is ever returned. `prefix` is the server-minted
    // non-sensitive display prefix (already persisted) — returned so the SPA need
    // not slice the plaintext to build a redacted view (a redaction footgun).
    return c.json({ key_id: keyId, plaintext: minted.plaintext, prefix: minted.prefix }, 201);
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
