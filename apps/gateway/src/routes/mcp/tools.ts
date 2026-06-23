import {
  buildReconciledFactBatch,
  type Embedder,
  MemoryFactContentHashConflictError,
  type MemoryStore,
  type ScoreConfig,
} from "@helm/core";
import type { Fact, Reflection } from "@helm/shared";
import { z } from "zod";

// docs/13 — Memory MCP tools (transport-agnostic). This module is the SDK-free
// core of the MCP server: tool definitions (Zod input schemas) + handlers that
// drive the MemoryStore. The JSON-RPC/HTTP wiring lives in ./index.ts and only
// calls listMemoryTools() + callMemoryTool(), so swapping the transport later
// (e.g. to the MCP SDK's Web-standard StreamableHTTP) touches one file, not these.
//
// Tenant isolation (docs/13): accountId comes ONLY from the authenticated context
// — never a tool argument. Scope params (projectId/resourceId/threadId) narrow
// WITHIN the account; id-addressed tools re-check owner_id in the store, so a
// guessed cross-tenant id returns not-found.

// The store methods the MCP surface needs, promoted from optional to required:
// the server only mounts when supportsMemoryAdmin() confirms a full adapter, so
// the handlers can call them without null-checks (and stay type-safe, no `!`).
export type MemoryAdminStore = MemoryStore &
  Required<
    Pick<
      MemoryStore,
      | "insertFactsReconciled"
      | "listMemoryScopes"
      | "listFacts"
      | "getFactById"
      | "updateFact"
      | "deleteFact"
      | "listReflections"
      | "getReflectionById"
      | "updateReflectionText"
      | "deleteReflection"
      | "getReflectionVersionHighWater"
    >
  >;

const REQUIRED_METHODS = [
  "insertFactsReconciled",
  "listMemoryScopes",
  "listFacts",
  "getFactById",
  "updateFact",
  "deleteFact",
  "listReflections",
  "getReflectionById",
  "updateReflectionText",
  "deleteReflection",
  "getReflectionVersionHighWater",
] as const satisfies ReadonlyArray<keyof MemoryStore>;

// Runtime guard: does this store implement the whole management surface? Used at
// mount time so the route is only registered against a capable adapter.
export function supportsMemoryAdmin(store: MemoryStore): store is MemoryAdminStore {
  return REQUIRED_METHODS.every((m) => typeof store[m] === "function");
}

// Per-request context resolved from the authenticated identity. accountId is the
// HARD tenant boundary; defaultProjectId is the key's memory_project_id (the scope
// a tool defaults to when the caller omits one).
export interface MemoryToolContext {
  accountId: string;
  defaultProjectId: string | null;
  store: MemoryAdminStore;
  now: () => Date;
  estimateTokens: (text: string) => number;
  // docs/14 — hybrid recall (memory_recall). embedder is OPTIONAL: absent ⇒ the vector
  // leg is skipped (FTS+score). scoreConfig is the forgetting curve for the score
  // signal. recall carries the gate + top-K (memory.forgetting.facts_retrieval).
  embedder?: Embedder;
  scoreConfig: ScoreConfig;
  recall: { enabled: boolean; topK: number };
}

// MCP tool result envelope (the subset we emit). isError marks a tool-level
// failure (the JSON-RPC call still succeeds — MCP convention).
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Resolve an in-account scope from tool args, defaulting project to the key's
// memory_project_id. The account is NEVER taken from args (tenant isolation).
function scopeInput(
  ctx: MemoryToolContext,
  args: { projectId?: string; resourceId?: string; threadId?: string },
): { projectId?: string; resourceId?: string; threadId?: string } {
  const scope: { projectId?: string; resourceId?: string; threadId?: string } = {};
  const projectId = args.projectId ?? ctx.defaultProjectId ?? undefined;
  if (projectId != null) scope.projectId = projectId;
  if (args.resourceId !== undefined) scope.resourceId = args.resourceId;
  if (args.threadId !== undefined) scope.threadId = args.threadId;
  return scope;
}

function factView(f: Fact) {
  return {
    id: f.id,
    subject: f.subjectKey,
    text: f.factText,
    scope: { projectId: f.projectId, resourceId: f.resourceId, threadId: f.threadId },
    importance: f.importance,
    status: f.status,
    superseded: f.expiredAt !== null,
    validFrom: f.validFrom.toISOString(),
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function reflectionView(r: Reflection) {
  return {
    id: r.id,
    text: r.reflectionText,
    version: r.version,
    scope: { projectId: r.projectId, resourceId: r.resourceId, threadId: r.threadId },
    status: r.status,
    updatedAt: r.updatedAt.toISOString(),
  };
}

const scopeFields = {
  projectId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
};
const typeField = z.enum(["fact", "reflection"]);

// ---- Tool schemas ----------------------------------------------------------

const addSchema = z.object({
  type: typeField,
  text: z.string().min(1),
  // Facts only: the topic key for same-subject supersede. Defaults to the fact
  // text when omitted (so a re-asserted fact still dedups/supersedes).
  subject: z.string().min(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  ...scopeFields,
});

const searchSchema = z.object({
  type: typeField.optional(),
  query: z.string().min(1),
  includeInactive: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  ...scopeFields,
});

const listSchema = z.object({
  type: typeField,
  includeInactive: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  ...scopeFields,
});

const getSchema = z.object({ type: typeField, id: z.string().min(1) });

const updateSchema = z.object({
  type: typeField,
  id: z.string().min(1),
  text: z.string().min(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  status: z.enum(["active", "archived", "pruned"]).optional(),
  // Facts only, bi-temporal: ISO timestamp the fact became false, or null to clear.
  invalidAt: z.string().nullable().optional(),
});

const deleteSchema = z.object({ type: typeField, id: z.string().min(1) });

// ---- Tool handlers ---------------------------------------------------------

async function handleAdd(
  args: z.infer<typeof addSchema>,
  ctx: MemoryToolContext,
): Promise<McpToolResult> {
  const scope = scopeInput(ctx, args);
  if (args.type === "fact") {
    const facts = buildReconciledFactBatch({
      extracted: [
        { subjectText: args.subject ?? args.text, factText: args.text, validFrom: ctx.now() },
      ],
      ownerId: ctx.accountId,
      scope,
      cap: 1,
      fallbackNow: ctx.now(),
    });
    if (args.importance !== undefined && facts[0] !== undefined)
      facts[0].importance = args.importance;
    if (facts.length === 0) return fail("fact text/subject is empty after normalization");
    const res = (await ctx.store.insertFactsReconciled({
      accountId: ctx.accountId,
      scope,
      facts,
      now: ctx.now(),
    })) ?? { insertedIds: [], supersededIds: [], resurrectedIds: [] };
    // A re-added fact that had been deleted is REACTIVATED (resurrected), not a
    // fresh insert — report it distinctly and don't mislabel it as a plain dedup.
    const resurrected = res.resurrectedIds ?? [];
    return ok({
      added: res.insertedIds,
      resurrected,
      superseded: res.supersededIds,
      deduped: res.insertedIds.length === 0 && resurrected.length === 0,
    });
  }
  const highWater = await ctx.store.getReflectionVersionHighWater({
    accountId: ctx.accountId,
    ...scope,
  });
  const version = highWater + 1;
  const id = await ctx.store.upsertReflection({
    accountId: ctx.accountId,
    ...scope,
    reflectionText: args.text,
    version,
    tokenEstimate: ctx.estimateTokens(args.text),
    updatedAt: ctx.now(),
  });
  return ok({ id, version });
}

async function handleSearch(
  args: z.infer<typeof searchSchema>,
  ctx: MemoryToolContext,
): Promise<McpToolResult> {
  const limit = args.limit ?? 20;
  const scope = scopeInput(ctx, args);
  const out: Record<string, unknown> = {};
  if (args.type === undefined || args.type === "fact") {
    const { rows } = await ctx.store.listFacts({
      accountId: ctx.accountId,
      ...scope,
      status: args.includeInactive ? "all" : "active",
      search: args.query,
      limit,
      offset: 0,
    });
    out.facts = rows.map(factView);
  }
  if (args.type === undefined || args.type === "reflection") {
    const { rows } = await ctx.store.listReflections({
      accountId: ctx.accountId,
      ...scope,
      status: args.includeInactive ? "all" : "active",
      limit: 1000,
      offset: 0,
    });
    const q = args.query.toLowerCase();
    out.reflections = rows
      .filter((r) => r.reflectionText.toLowerCase().includes(q))
      .slice(0, limit)
      .map(reflectionView);
  }
  return ok(out);
}

const recallSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  ...scopeFields,
});

// docs/14 — DEEP RECALL. Hybrid relevance search over facts (vector + FTS5 trigram +
// forgetting score, RRF-fused), distinct from memory_search's substring LIKE. Gated by
// memory.forgetting.facts_retrieval.enabled; FAIL-OPEN — a disabled gate, an absent
// searchFacts adapter, OR a search/embed error all degrade to the LIKE path so the tool
// never errors. Recalled facts get a fire-and-forget reinforcement bump.
async function handleRecall(
  args: z.infer<typeof recallSchema>,
  ctx: MemoryToolContext,
): Promise<McpToolResult> {
  const scope = scopeInput(ctx, args);
  const limit = args.limit ?? ctx.recall.topK;
  const searchFacts = ctx.store.searchFacts?.bind(ctx.store);

  const degradeToLike = async (): Promise<McpToolResult> => {
    const { rows } = await ctx.store.listFacts({
      accountId: ctx.accountId,
      ...scope,
      status: "active",
      search: args.query,
      limit,
      offset: 0,
    });
    return ok({ facts: rows.map(factView), degraded: true });
  };

  if (!ctx.recall.enabled || searchFacts === undefined) return degradeToLike();

  // Embed the query for the vector leg; fail-open drops the leg (FTS+score still run).
  let queryEmbedding: Float32Array | undefined;
  if (ctx.embedder !== undefined) {
    try {
      const [vec] = await ctx.embedder.embed([args.query]);
      queryEmbedding = vec;
    } catch {
      queryEmbedding = undefined;
    }
  }

  let facts: Fact[];
  try {
    facts = await searchFacts({
      accountId: ctx.accountId,
      ...scope,
      queryText: args.query,
      ...(queryEmbedding !== undefined ? { queryEmbedding } : {}),
      limit,
      now: ctx.now(),
      scoreConfig: ctx.scoreConfig,
    });
  } catch {
    return degradeToLike();
  }

  // Reinforcement bump — recalled facts are "used". Fire-and-forget: never awaited,
  // never blocks or throws the tool response.
  if (facts.length > 0 && ctx.store.bumpReferences !== undefined) {
    void ctx.store
      .bumpReferences({
        accountId: ctx.accountId,
        observationIds: [],
        reflectionIds: [],
        factIds: facts.map((f) => f.id),
        now: ctx.now(),
      })
      .catch(() => {});
  }

  return ok({ facts: facts.map(factView) });
}

async function handleList(
  args: z.infer<typeof listSchema>,
  ctx: MemoryToolContext,
): Promise<McpToolResult> {
  const scope = scopeInput(ctx, args);
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  if (args.type === "fact") {
    const { rows, total } = await ctx.store.listFacts({
      accountId: ctx.accountId,
      ...scope,
      status: args.includeInactive ? "all" : "active",
      limit,
      offset,
    });
    return ok({ total, facts: rows.map(factView) });
  }
  const { rows, total } = await ctx.store.listReflections({
    accountId: ctx.accountId,
    ...scope,
    status: args.includeInactive ? "all" : "active",
    limit,
    offset,
  });
  return ok({ total, reflections: rows.map(reflectionView) });
}

async function handleGet(
  args: z.infer<typeof getSchema>,
  ctx: MemoryToolContext,
): Promise<McpToolResult> {
  if (args.type === "fact") {
    const f = await ctx.store.getFactById({ accountId: ctx.accountId, id: args.id });
    return f === null ? fail(`fact not found: ${args.id}`) : ok(factView(f));
  }
  const r = await ctx.store.getReflectionById({ accountId: ctx.accountId, id: args.id });
  return r === null ? fail(`reflection not found: ${args.id}`) : ok(reflectionView(r));
}

async function handleUpdate(
  args: z.infer<typeof updateSchema>,
  ctx: MemoryToolContext,
): Promise<McpToolResult> {
  if (args.type === "fact") {
    let invalidAt: Date | null | undefined;
    if (args.invalidAt === null) invalidAt = null;
    else if (typeof args.invalidAt === "string") {
      const d = new Date(args.invalidAt);
      if (Number.isNaN(d.getTime()))
        return fail(`invalidAt is not a valid timestamp: ${args.invalidAt}`);
      invalidAt = d;
    }
    const patch: {
      factText?: string;
      importance?: number;
      status?: "active" | "archived" | "pruned";
      invalidAt?: Date | null;
    } = {};
    if (args.text !== undefined) patch.factText = args.text;
    if (args.importance !== undefined) patch.importance = args.importance;
    if (args.status !== undefined) patch.status = args.status;
    if (invalidAt !== undefined) patch.invalidAt = invalidAt;
    const updated = await ctx.store.updateFact({
      accountId: ctx.accountId,
      id: args.id,
      patch,
      now: ctx.now(),
    });
    return updated === null ? fail(`fact not found: ${args.id}`) : ok(factView(updated));
  }
  if (args.text === undefined) return fail("reflection update requires `text`");
  const updated = await ctx.store.updateReflectionText({
    accountId: ctx.accountId,
    id: args.id,
    reflectionText: args.text,
    tokenEstimate: ctx.estimateTokens(args.text),
    now: ctx.now(),
  });
  return updated === null ? fail(`reflection not found: ${args.id}`) : ok(reflectionView(updated));
}

async function handleDelete(
  args: z.infer<typeof deleteSchema>,
  ctx: MemoryToolContext,
): Promise<McpToolResult> {
  const deleted =
    args.type === "fact"
      ? await ctx.store.deleteFact({ accountId: ctx.accountId, id: args.id, now: ctx.now() })
      : await ctx.store.deleteReflection({ accountId: ctx.accountId, id: args.id });
  return ok({ deleted, id: args.id });
}

// The registry erases each tool's specific arg type to `unknown`; defineTool
// pairs a Zod schema with a handler typed for that schema, and callMemoryTool
// re-narrows via safeParse before dispatch (so the erasing cast is sound).
interface ToolDef {
  description: string;
  schema: z.ZodType;
  handler: (args: unknown, ctx: MemoryToolContext) => Promise<McpToolResult>;
}

function defineTool<S extends z.ZodType>(
  description: string,
  schema: S,
  handler: (args: z.infer<S>, ctx: MemoryToolContext) => Promise<McpToolResult>,
): ToolDef {
  return { description, schema, handler: handler as ToolDef["handler"] };
}

const TOOLS: Record<string, ToolDef> = {
  memory_add: defineTool(
    "Store a new memory. type='fact' adds a discrete assertion (deduped + same-subject superseded); type='reflection' appends a long-form summary. Scope defaults to the key's project.",
    addSchema,
    handleAdd,
  ),
  memory_search: defineTool(
    "Search memories by text. Omit `type` to search both facts and reflections. Returns active memories unless includeInactive=true.",
    searchSchema,
    handleSearch,
  ),
  memory_recall: defineTool(
    "Deep relevance search over remembered facts — recall what was discussed or decided about a topic, across sessions. Ranks by meaning (cross-lingual when embeddings are configured) + keywords + recency. Use this for recall; memory_search is exact substring; memory_list browses.",
    recallSchema,
    handleRecall,
  ),
  memory_list: defineTool(
    "List memories of a `type` (paginated). Returns active memories unless includeInactive=true.",
    listSchema,
    handleList,
  ),
  memory_get: defineTool("Fetch a single memory by id.", getSchema, handleGet),
  memory_update: defineTool(
    "Edit a memory. For facts: text (rewords + re-hashes), importance, status, invalidAt. For reflections: text (required). Editing a fact to identical text as another fact fails.",
    updateSchema,
    handleUpdate,
  ),
  memory_delete: defineTool(
    "Soft-delete a memory (facts → pruned, reflections → archived). Reversible only by an operator.",
    deleteSchema,
    handleDelete,
  ),
};

// The tool list for MCP `tools/list`. Zod → JSON Schema (draft 2020-12), the same
// converter the gateway's OpenAPI route uses, so the wire schema is single-sourced.
export function listMemoryTools(): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema, { target: "draft-2020-12" }),
  }));
}

// Dispatch an MCP `tools/call`. Validates args with the tool's Zod schema (→ a
// tool-level error result on mismatch, not a JSON-RPC error), runs the handler,
// and maps a content_hash collision to a clean isError result (never a 500).
export async function callMemoryTool(
  name: string,
  rawArgs: unknown,
  ctx: MemoryToolContext,
): Promise<McpToolResult> {
  const tool = TOOLS[name];
  if (tool === undefined) return fail(`unknown tool: ${name}`);
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return fail(`invalid arguments: ${detail}`);
  }
  try {
    return await tool.handler(parsed.data, ctx);
  } catch (e) {
    if (e instanceof MemoryFactContentHashConflictError) return fail(e.message);
    return fail(e instanceof Error ? e.message : "internal error");
  }
}
