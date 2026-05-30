import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

// Hop-by-hop headers must not be forwarded (RFC 7230). Stripped from the request
// view before downstream sees it.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

declare module "hono" {
  interface ContextVariableMap {
    request_id: string;
  }
}

// Normalize request headers + request_id. request_id comes from X-Request-Id /
// X-Trace-Id, falling back to the generated trace_id; it is written to the
// context and echoed in the X-Request-Id response header. Hop-by-hop headers are
// removed. Authorization is left untouched (auth owns it).
export function normalizeHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("X-Request-Id") ?? c.req.header("X-Trace-Id");
    const requestId = incoming && incoming.length > 0 ? incoming : c.get("trace_id");
    c.set("request_id", requestId);
    c.header("X-Request-Id", requestId);

    for (const name of HOP_BY_HOP) {
      if (c.req.raw.headers.has(name)) {
        c.req.raw.headers.delete(name);
      }
    }
    await next();
  };
}
