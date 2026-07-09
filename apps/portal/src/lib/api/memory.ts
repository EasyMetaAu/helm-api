import { mcpTool } from "./client";

// Portal memory over MCP tools/call (docs/12 §4.2 endpoint 6). accountId/projectId
// are server-derived from the bearer key — never sent (R3/R4).
export type MemoryStatus = "active" | "archived" | "pruned";
export type FactStatusFilter = MemoryStatus | "superseded" | "all";

export interface Fact {
  id: string;
  subject: string | null;
  text: string;
  importance: number;
  status: MemoryStatus;
  superseded: boolean;
  createdAt: string;
  updatedAt: string;
  subjectKey: string;
  factText: string;
  expiredAt: string | null;
}

export interface Reflection {
  id: string;
  text: string;
  version: number;
  status: "active" | "archived";
  updatedAt: string;
  reflectionText: string;
}

export interface FactCreateResult {
  added: string[];
  resurrected?: string[];
  superseded: string[];
  deduped: boolean;
}

interface RawFact {
  id: string;
  subject: string | null;
  text: string;
  importance: number;
  status: MemoryStatus;
  superseded: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawReflection {
  id: string;
  text: string;
  version: number;
  status: "active" | "archived";
  updatedAt: string;
}

function normalizeFact(f: RawFact): Fact {
  return {
    ...f,
    subjectKey: f.subject ?? "",
    factText: f.text,
    expiredAt: f.superseded ? f.updatedAt : null,
  };
}

function normalizeReflection(r: RawReflection): Reflection {
  return { ...r, reflectionText: r.text };
}

export async function listFacts(
  options: { includeInactive?: boolean; limit?: number; offset?: number } = {},
): Promise<{ total: number; facts: Fact[] }> {
  const page = await mcpTool<{ total: number; facts: RawFact[] }>(
    "memory_list",
    {
      type: "fact",
      includeInactive: options.includeInactive ?? false,
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    },
  );
  return { total: page.total, facts: page.facts.map(normalizeFact) };
}

export async function listAllFacts(includeInactive = false): Promise<Fact[]> {
  const out: Fact[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (out.length < total) {
    const page = await listFacts({ includeInactive, limit: 100, offset });
    out.push(...page.facts);
    total = page.total;
    if (page.facts.length === 0) break;
    offset += page.facts.length;
  }
  return out;
}

export async function listReflections(
  options: { includeInactive?: boolean; limit?: number; offset?: number } = {},
): Promise<{ total: number; reflections: Reflection[] }> {
  const page = await mcpTool<{ total: number; reflections: RawReflection[] }>(
    "memory_list",
    {
      type: "reflection",
      includeInactive: options.includeInactive ?? false,
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    },
  );
  return {
    total: page.total,
    reflections: page.reflections.map(normalizeReflection),
  };
}

export async function listAllReflections(
  includeInactive = true,
): Promise<Reflection[]> {
  const out: Reflection[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (out.length < total) {
    const page = await listReflections({ includeInactive, limit: 100, offset });
    out.push(...page.reflections);
    total = page.total;
    if (page.reflections.length === 0) break;
    offset += page.reflections.length;
  }
  return out;
}

export function createFact(
  subject: string,
  text: string,
  importance: number,
): Promise<FactCreateResult> {
  return mcpTool("memory_add", {
    type: "fact",
    subject: subject.trim(),
    text: text.trim(),
    importance,
  });
}

export async function updateFact(
  id: string,
  patch: { text: string; importance: number; status: MemoryStatus },
): Promise<Fact> {
  const updated = await mcpTool<RawFact>("memory_update", {
    type: "fact",
    id,
    text: patch.text.trim(),
    importance: patch.importance,
    status: patch.status,
  });
  return normalizeFact(updated);
}

export function deleteFact(id: string): Promise<unknown> {
  return mcpTool("memory_delete", { type: "fact", id });
}

export async function updateReflection(
  id: string,
  text: string,
): Promise<Reflection> {
  const updated = await mcpTool<RawReflection>("memory_update", {
    type: "reflection",
    id,
    text: text.trim(),
  });
  return normalizeReflection(updated);
}

export function deleteReflection(id: string): Promise<unknown> {
  return mcpTool("memory_delete", { type: "reflection", id });
}

export async function searchFacts(query: string): Promise<Fact[]> {
  const result = await mcpTool<{ facts?: RawFact[] }>("memory_search", {
    type: "fact",
    query: query.trim(),
    includeInactive: true,
    limit: 100,
  });
  return (result.facts ?? []).map(normalizeFact);
}
