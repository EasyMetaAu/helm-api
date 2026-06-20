import { MemoryFactContentHashConflictError } from "@helm/core";
import {
  MemoryFactPatchSchema,
  MemoryReflectionPatchSchema,
  type MemoryStatus,
} from "@helm/shared";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.js";
import { type MemoryAdminStore, supportsMemoryAdmin } from "../mcp/tools.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/memory — manage the long-tier memory (facts + reflections) the
// gateway accumulates (docs/13). Behind the admin basicAuth like every other
// /admin/api/* route. This is a MANAGEMENT surface: reads expose superseded /
// archived / pruned rows (status filter), edits recompute content_hash (409 on
// collision), deletes are SOFT. Pure HTTP↔domain glue (Principle 1): all IO is in
// deps.memoryStore. Returns 503 when no capable memory store is wired (fail-closed
// for the surface — distinct from the routing hot path, which never 5xx's).

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const FACT_STATUSES = new Set(["active", "archived", "pruned", "all"]);
const REFLECTION_STATUSES = new Set(["active", "archived", "all"]);

// Resolve the capable store or send a 503. Hono pattern: returns the store, or a
// Response the handler returns directly.
function resolveStore(c: Context<AppEnv>, deps: AdminApiDeps): MemoryAdminStore | Response {
  const store = deps.memoryStore;
  if (store === undefined || !supportsMemoryAdmin(store)) {
    return c.json({ error: "memory store unavailable" }, 503);
  }
  return store;
}

function accountOf(c: Context<AppEnv>, deps: AdminApiDeps): string {
  return c.req.query("accountId") ?? deps.accountId;
}

function intParam(value: string | undefined, def: number, max: number): number {
  if (value === undefined) return def;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) return def;
  return Math.min(n, max);
}

// Build the in-account scope filter from query params (each present-only).
function scopeFromQuery(c: Context<AppEnv>): {
  projectId?: string;
  resourceId?: string;
  threadId?: string;
} {
  const scope: { projectId?: string; resourceId?: string; threadId?: string } = {};
  const p = c.req.query("projectId");
  const r = c.req.query("resourceId");
  const t = c.req.query("threadId");
  if (p !== undefined && p !== "") scope.projectId = p;
  if (r !== undefined && r !== "") scope.resourceId = r;
  if (t !== undefined && t !== "") scope.threadId = t;
  return scope;
}

export function registerMemoryRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  const estimateTokens = deps.estimateTokens ?? ((text: string) => Math.ceil(text.length / 4));

  // GET /memory/scopes — the "By Scope" tab: one row per (account,project,
  // resource,thread) group with fact/reflection counts + last-updated.
  app.get("/admin/api/memory/scopes", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const accountId = c.req.query("accountId") ?? undefined;
    const scopes = await store.listMemoryScopes(accountId !== undefined ? { accountId } : {});
    return c.json(scopes);
  });

  // GET /memory/by-key/:keyId — resolve a key to its memory scope (account +
  // default project) for the "By Key" tab. Admin surface is already privileged,
  // so exposing the account here is fine. 404 on unknown key.
  app.get("/admin/api/memory/by-key/:keyId", async (c) => {
    const keyId = c.req.param("keyId");
    const key = (await deps.keyStore.list()).find((r) => r.key_id === keyId);
    if (key === undefined) return c.json({ error: "key not found" }, 404);
    return c.json({
      key_id: key.key_id,
      accountId: key.account_id,
      projectId: key.memory_project_id,
    });
  });

  // GET /memory/facts — paginated, with status visibility (default 'all' so a
  // management view shows superseded/archived/pruned rows too).
  app.get("/admin/api/memory/facts", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const statusRaw = c.req.query("status") ?? "all";
    if (!FACT_STATUSES.has(statusRaw)) {
      return c.json({ error: `invalid status: ${statusRaw}` }, 400);
    }
    const subjectKey = c.req.query("subjectKey");
    const search = c.req.query("search");
    const page = await store.listFacts({
      accountId: accountOf(c, deps),
      ...scopeFromQuery(c),
      status: statusRaw as MemoryStatus | "all",
      ...(subjectKey !== undefined && subjectKey !== "" ? { subjectKey } : {}),
      ...(search !== undefined && search !== "" ? { search } : {}),
      limit: intParam(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT),
      offset: intParam(c.req.query("offset"), 0, Number.MAX_SAFE_INTEGER),
    });
    return c.json(page);
  });

  // GET /memory/facts/:id
  app.get("/admin/api/memory/facts/:id", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const fact = await store.getFactById({ accountId: accountOf(c, deps), id: c.req.param("id") });
    return fact === null ? c.json({ error: "fact not found" }, 404) : c.json(fact);
  });

  // PATCH /memory/facts/:id — edit (factText/importance/status/invalidAt). 409 on
  // a content_hash collision; 404 on unknown id.
  app.patch("/admin/api/memory/facts/:id", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const parsed = MemoryFactPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid fact patch", issues: parsed.error.issues }, 400);
    }
    try {
      const updated = await store.updateFact({
        accountId: accountOf(c, deps),
        id: c.req.param("id"),
        patch: parsed.data,
        now: new Date(),
      });
      return updated === null ? c.json({ error: "fact not found" }, 404) : c.json(updated);
    } catch (e) {
      if (e instanceof MemoryFactContentHashConflictError) {
        return c.json({ error: e.message }, 409);
      }
      throw e;
    }
  });

  // DELETE /memory/facts/:id — soft delete (status='pruned'). 404 if unknown or
  // already pruned.
  app.delete("/admin/api/memory/facts/:id", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const id = c.req.param("id");
    const deleted = await store.deleteFact({ accountId: accountOf(c, deps), id, now: new Date() });
    return deleted ? c.json({ deleted: id }) : c.json({ error: "fact not found" }, 404);
  });

  // GET /memory/reflections — paginated; default latest active version per scope.
  app.get("/admin/api/memory/reflections", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const statusRaw = c.req.query("status") ?? "all";
    if (!REFLECTION_STATUSES.has(statusRaw)) {
      return c.json({ error: `invalid status: ${statusRaw}` }, 400);
    }
    const page = await store.listReflections({
      accountId: accountOf(c, deps),
      ...scopeFromQuery(c),
      status: statusRaw as "active" | "archived" | "all",
      includeAllVersions: c.req.query("includeAllVersions") === "true",
      limit: intParam(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT),
      offset: intParam(c.req.query("offset"), 0, Number.MAX_SAFE_INTEGER),
    });
    return c.json(page);
  });

  // GET /memory/reflections/:id
  app.get("/admin/api/memory/reflections/:id", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const r = await store.getReflectionById({
      accountId: accountOf(c, deps),
      id: c.req.param("id"),
    });
    return r === null ? c.json({ error: "reflection not found" }, 404) : c.json(r);
  });

  // PATCH /memory/reflections/:id — edit text in place (no version bump).
  app.patch("/admin/api/memory/reflections/:id", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const parsed = MemoryReflectionPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid reflection patch", issues: parsed.error.issues }, 400);
    }
    const updated = await store.updateReflectionText({
      accountId: accountOf(c, deps),
      id: c.req.param("id"),
      reflectionText: parsed.data.reflectionText,
      tokenEstimate: estimateTokens(parsed.data.reflectionText),
      now: new Date(),
    });
    return updated === null ? c.json({ error: "reflection not found" }, 404) : c.json(updated);
  });

  // DELETE /memory/reflections/:id — two-stage: an active row soft-deletes
  // (status='archived'); a second delete on an already-archived row hard-purges
  // it. 404 only when the id is genuinely unknown/cross-tenant.
  app.delete("/admin/api/memory/reflections/:id", async (c) => {
    const store = resolveStore(c, deps);
    if (store instanceof Response) return store;
    const id = c.req.param("id");
    const deleted = await store.deleteReflection({ accountId: accountOf(c, deps), id });
    return deleted ? c.json({ deleted: id }) : c.json({ error: "reflection not found" }, 404);
  });
}
