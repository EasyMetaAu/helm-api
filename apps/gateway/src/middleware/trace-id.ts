import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

// Generate the internal request_id and independently resolve the client-facing
// trace_id. The internal id is NEVER sourced from request headers: telemetry and
// payload ownership use it as a security boundary. X-Request-Id / X-Trace-Id stay
// useful as correlation metadata and are echoed unchanged for compatibility.
// MUST run before the request logger so the first log line has a trace_id.
export function traceIdMiddleware(
  genTraceId: () => string = randomUUID,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("X-Request-Id") ?? c.req.header("X-Trace-Id");
    const requestId = genTraceId();
    const traceId = incoming && incoming.length > 0 ? incoming : requestId;
    c.set("request_id", requestId);
    c.set("trace_id", traceId);
    c.header("X-Helm-Request-Id", requestId);
    c.header("X-Trace-Id", traceId);
    await next();
  };
}
