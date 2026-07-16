import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

// Structured access logger: emits one completion log per request with
// { request_id, trace_id, method, path, status, duration_ms }. Never logs Authorization or
// other secrets (principle 7).
export function requestLoggerMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    await next();
    c.get("logger").log("info", "request.completed", {
      request_id: c.get("request_id"),
      trace_id: c.get("trace_id"),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - start,
    });
  };
}
