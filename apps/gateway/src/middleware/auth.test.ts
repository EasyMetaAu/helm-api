import type { ApiKeyRecord } from "@helm/core";
import { hashKey } from "@helm/core";
import { HelmErrorSchema } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { type AuthDeps, authMiddleware } from "./auth.js";

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    max_lane: "balanced",
    allowed_lanes: ["economy", "balanced"],
    allow_custom_model: false,
    disabled: false,
    ...overrides,
  };
}

// Build an app with the middleware in front of a downstream handler that reports
// whether it ran and echoes the resolved identity.
function buildApp(deps: AuthDeps) {
  const downstream = vi.fn();
  const app = new Hono();
  app.use("*", authMiddleware(deps));
  app.get("/protected", (c) => {
    downstream();
    return c.json({ identity: c.get("identity") });
  });
  return { app, downstream };
}

describe("authMiddleware", () => {
  it("rejects a request with no key (auth_error 401, downstream not run)", async () => {
    const getByHash = vi.fn();
    const { app, downstream } = buildApp({ keyStore: { getByHash }, log: () => {} });
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error_class).toBe("auth_error");
    expect(getByHash).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects an unknown key (getByHash -> null)", async () => {
    const getByHash = vi.fn().mockResolvedValue(null);
    const { app, downstream } = buildApp({ keyStore: { getByHash }, log: () => {} });
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer helm_live_unknown" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).error_class).toBe("auth_error");
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects a disabled key", async () => {
    const getByHash = vi.fn().mockResolvedValue(record({ disabled: true }));
    const { app, downstream } = buildApp({ keyStore: { getByHash }, log: () => {} });
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer helm_live_secret" },
    });
    expect(res.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("accepts a valid key, attaches identity, and runs downstream", async () => {
    const getByHash = vi.fn().mockResolvedValue(record());
    const { app, downstream } = buildApp({ keyStore: { getByHash }, log: () => {} });
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer helm_live_secret" },
    });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.identity).toMatchObject({
      keyId: "k1",
      accountId: "acct",
      role: "user",
      caps: { maxLane: "balanced", allowedLanes: ["economy", "balanced"], allowCustomModel: false },
    });
  });

  it("hashes the plaintext with the same hashKey the keygen uses", async () => {
    const getByHash = vi.fn().mockResolvedValue(record());
    const { app } = buildApp({ keyStore: { getByHash }, log: () => {} });
    await app.request("/protected", { headers: { Authorization: "Bearer helm_live_secret" } });
    expect(getByHash).toHaveBeenCalledWith(hashKey("helm_live_secret"));
  });

  it("accepts the x-api-key header as a fallback", async () => {
    const getByHash = vi.fn().mockResolvedValue(record());
    const { app, downstream } = buildApp({ keyStore: { getByHash }, log: () => {} });
    const res = await app.request("/protected", {
      headers: { "x-api-key": "helm_live_secret" },
    });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("never leaks the plaintext key in logs or the response body", async () => {
    const getByHash = vi.fn().mockResolvedValue(null);
    const logs: string[] = [];
    const { app } = buildApp({ keyStore: { getByHash }, log: (l) => logs.push(l) });
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer helm_live_supersecret_PLAINTEXT" },
    });
    const text = await res.text();
    expect(text).not.toContain("helm_live_supersecret_PLAINTEXT");
    expect(logs.join("\n")).not.toContain("helm_live_supersecret_PLAINTEXT");
  });

  it("returns a schema-valid HelmError body with a trace_id", async () => {
    const getByHash = vi.fn().mockResolvedValue(null);
    const { app } = buildApp({ keyStore: { getByHash }, log: () => {} });
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer helm_live_x" },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(HelmErrorSchema.safeParse(body).success).toBe(true);
    expect(String(body.trace_id).length).toBeGreaterThan(0);
  });
});
