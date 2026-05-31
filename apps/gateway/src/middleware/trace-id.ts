import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

// Propagate or generate the request trace_id. Reads X-Request-Id / X-Trace-Id;
// if absent, generates a UUID. Writes it to c.set("trace_id") and the response
// header X-Trace-Id. MUST run before the request logger so the first log line
// has a trace_id.
export function traceIdMiddleware(
  genTraceId: () => string = randomUUID,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("X-Request-Id") ?? c.req.header("X-Trace-Id");
    const traceId = incoming && incoming.length > 0 ? incoming : genTraceId();
    c.set("trace_id", traceId);
    c.header("X-Trace-Id", traceId);
    await next();
  };
}
