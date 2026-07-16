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

// Normalize request headers and echo the client-facing correlation id. The
// server-generated request_id was already set by traceIdMiddleware and MUST NOT
// be replaced here: it keys telemetry/payload ownership. Hop-by-hop headers are
// removed. Authorization is left untouched (auth owns it).
export function normalizeHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("X-Request-Id") ?? c.req.header("X-Trace-Id");
    const correlationId = incoming && incoming.length > 0 ? incoming : c.get("trace_id");
    c.header("X-Request-Id", correlationId);

    for (const name of HOP_BY_HOP) {
      if (c.req.raw.headers.has(name)) {
        c.req.raw.headers.delete(name);
      }
    }
    await next();
  };
}
