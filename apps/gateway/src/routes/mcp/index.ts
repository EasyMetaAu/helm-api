import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { McpDeps } from "./deps.js";
import {
  callMemoryTool,
  listMemoryTools,
  type MemoryToolContext,
  supportsMemoryAdmin,
} from "./tools.js";

// docs/13 — Memory MCP server over HTTP JSON-RPC (the MCP "Streamable HTTP"
// transport in its non-streaming request/response form). A direct, spec-faithful
// implementation of the handshake + tool methods: CRUD tools need no SSE, and a
// hand-rolled JSON-RPC handler is fully testable via Hono's app.request() (the
// SDK's Node-req/res StreamableHTTPServerTransport is not). Tool logic lives in
// ./tools.ts (transport-agnostic), so a later swap to the SDK's Web-standard
// transport touches only this file.

// Protocol versions we accept on `initialize`. We echo the client's requested
// version when supported (forward/backward compat), else fall back to our latest.
const LATEST_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

type JsonRpcId = string | number | null;
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Handle ONE JSON-RPC message. Returns the response, or null for a notification
// (no id) — notifications, including `notifications/initialized`, get no reply.
async function handleRpc(
  message: unknown,
  ctx: MemoryToolContext,
  serverVersion: string,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null)
    return rpcError(null, -32600, "invalid request");
  const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: JsonRpcId = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  const isNotification = msg.id === undefined || msg.id === null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "invalid request");
  }
  if (isNotification) return null; // we have no notification side effects to run

  switch (msg.method) {
    case "initialize": {
      const params = (msg.params ?? {}) as { protocolVersion?: unknown };
      const requested =
        typeof params.protocolVersion === "string" &&
        SUPPORTED_PROTOCOLS.has(params.protocolVersion)
          ? params.protocolVersion
          : LATEST_PROTOCOL;
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "helm-memory", version: serverVersion },
        instructions:
          "Persistent memory for this account. Use memory_add to remember facts/reflections, memory_search/memory_list to recall, memory_update/memory_delete to curate.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: listMemoryTools() });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return rpcError(id, -32602, "invalid params: `name` is required");
      }
      const result = await callMemoryTool(params.name, params.arguments, ctx);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

// Register `POST /mcp`. The caller (server.ts) mounts authMiddleware on /mcp
// FIRST (so identity is resolved) and only invokes this when
// config.memory.mcp.enabled. If the store lacks the management surface the route
// is NOT registered (the server logs and /mcp stays 404 — fail-closed).
export function registerMcpServer(app: Hono<AppEnv>, deps: McpDeps): void {
  if (!supportsMemoryAdmin(deps.memoryStore)) {
    deps.log?.("memory.mcp.enabled but the store lacks the management surface; /mcp not mounted");
    return;
  }
  const store = deps.memoryStore; // narrowed to MemoryAdminStore by the guard
  const serverVersion = deps.serverVersion ?? "0.1.0";

  app.post("/mcp", async (c) => {
    const identity = c.get("identity");
    const ctx: MemoryToolContext = {
      accountId: identity.accountId,
      defaultProjectId: identity.caps.memory.projectId,
      store,
      now: deps.now,
      estimateTokens: deps.estimateTokens,
      scoreConfig: deps.scoreConfig,
      recall: deps.recall,
      runInBackground: deps.runInBackground,
      ...(deps.embedder !== undefined ? { embedder: deps.embedder } : {}),
    };

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "parse error"), 200);
    }

    if (Array.isArray(body)) {
      const responses: JsonRpcResponse[] = [];
      for (const m of body) {
        const r = await handleRpc(m, ctx, serverVersion);
        if (r !== null) responses.push(r);
      }
      // A batch of only notifications gets a 202 with no body (MCP convention).
      return responses.length === 0 ? c.body(null, 202) : c.json(responses, 200);
    }

    const r = await handleRpc(body, ctx, serverVersion);
    return r === null ? c.body(null, 202) : c.json(r, 200);
  });
}
