import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

function buildApp(genTraceId?: () => string) {
  const app = createApp({ logger: { log: () => {} }, genTraceId });
  app.get("/probe", (c) =>
    c.json({
      requestId: c.get("request_id"),
      hasConnection: c.req.raw.headers.has("connection"),
    }),
  );
  return app;
}

describe("normalize-headers middleware", () => {
  it("echoes an incoming X-Request-Id without using it as the internal request_id", async () => {
    const app = buildApp(() => "server-req-9");
    const res = await app.request("/probe", {
      headers: {
        "X-Request-Id": "req-9",
        "X-Helm-Request-Id": "attacker-selected-storage-id",
      },
    });
    expect(res.headers.get("X-Request-Id")).toBe("req-9");
    expect(res.headers.get("X-Helm-Request-Id")).toBe("server-req-9");
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe("server-req-9");
  });

  it("echoes the generated correlation id when the caller supplies no id", async () => {
    const app = buildApp();
    const res = await app.request("/probe");
    const traceId = res.headers.get("X-Trace-Id");
    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBe(traceId);
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(traceId);
  });

  it("strips hop-by-hop headers (e.g. Connection) from the request view", async () => {
    const app = buildApp();
    const res = await app.request("/probe", { headers: { Connection: "keep-alive" } });
    const body = (await res.json()) as { hasConnection: boolean };
    expect(body.hasConnection).toBe(false);
  });

  it("does not alter the Authorization header value", async () => {
    const app = createApp({ logger: { log: () => {} } });
    app.get("/auth", (c) => c.json({ auth: c.req.header("Authorization") ?? null }));
    const res = await app.request("/auth", { headers: { Authorization: "Bearer keep-me" } });
    const body = (await res.json()) as { auth: string };
    expect(body.auth).toBe("Bearer keep-me");
  });
});
