import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";

const inboundClient = new AsyncLocalStorage<{ userAgent: string | undefined }>();

/** Capture the HTTP header independently of protocol translation and body metadata. */
export function relayClientIdentityMiddleware(): MiddlewareHandler {
  return (c, next) => inboundClient.run({ userAgent: c.req.header("user-agent") }, next);
}

/** Apply only at a Helm relay's final HTTP send or WebSocket handshake. */
export function helmRelayHeaders(source: ConstructorParameters<typeof Headers>[0]): Headers {
  const headers = new Headers(source);
  const client = inboundClient.getStore();
  if (client) {
    // An empty value suppresses fetch's default "node" UA when ingress had none.
    headers.set("user-agent", client.userAgent ?? "");
  }
  return headers;
}
