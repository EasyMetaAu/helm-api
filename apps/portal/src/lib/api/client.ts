import { base } from "$app/paths";
import { getKey, clearKey } from "$lib/auth";

// The portal's single fetch wrapper. Injects Authorization: Bearer from the
// sessionStorage key (never a query/body — R6). On 401 it clears the session and
// bounces to /login (the key was revoked/disabled). Read-only GETs only in the
// MVP; memory writes go through mcpFetch (POST /mcp), not here.
const API_BASE = `${base}/api`;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const key = getKey();
  if (!key) {
    clearKey();
    throw new ApiError(401, "no api key");
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json", Authorization: `Bearer ${key}` },
  });
  if (res.status === 401) {
    clearKey();
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    throw new ApiError(res.status, `portal api ${res.status}`);
  }
  return (await res.json()) as T;
}

// The memory channel: the SPA speaks JSON-RPC `tools/call` to the existing POST
// /mcp (docs/12 §4.2 endpoint 6 — zero new backend). accountId/projectId are
// derived server-side from the bearer key; the SPA never sends them (R3/R4).
// The tool result is `{content:[{type:"text",text:<JSON>}]}` — we parse the text.
export async function mcpTool<T>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const key = getKey();
  if (!key) {
    clearKey();
    throw new ApiError(401, "no api key");
  }
  // /mcp lives at the ORIGIN ROOT (not under /portal) — same-origin so the CSP
  // connect-src 'self' covers it.
  const res = await fetch("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (res.status === 401) {
    clearKey();
    throw new ApiError(401, "unauthorized");
  }
  if (res.status === 404) throw new ApiError(404, "memory not enabled");
  if (!res.ok) throw new ApiError(res.status, `mcp ${res.status}`);
  const body = (await res.json()) as {
    result?: { content?: { type: string; text: string }[]; isError?: boolean };
    error?: { message: string };
  };
  if (body.error) throw new ApiError(200, body.error.message);
  const text = body.result?.content?.[0]?.text ?? "{}";
  if (body.result?.isError) throw new ApiError(200, text);
  return JSON.parse(text) as T;
}
