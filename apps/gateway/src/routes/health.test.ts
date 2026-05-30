import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { BuildInfo } from "../build-info.js";
import type { HealthDeps } from "./health.js";

const BUILD: BuildInfo = { version: "0.1.0", gitSha: "a1b2c3d", builtAt: "2026-05-30T00:00:00Z" };

function appWith(health: HealthDeps) {
  return createApp({ logger: { log: () => {} }, health });
}

describe("health routes", () => {
  it("returns 200 ok when ready", async () => {
    const app = appWith({
      checkReadiness: async () => ({ ready: true, checks: { store: "ok" } }),
      buildInfo: BUILD,
    });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", ready: true, checks: { store: "ok" } });
  });

  it("returns 503 degraded when not ready", async () => {
    const app = appWith({
      checkReadiness: async () => ({ ready: false, checks: { store: "fail" } }),
      buildInfo: BUILD,
    });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "degraded",
      ready: false,
      checks: { store: "fail" },
    });
  });

  it("fails closed to 503 when the probe throws", async () => {
    const log = vi.fn();
    const app = createApp({
      logger: { log },
      health: {
        checkReadiness: async () => {
          throw new Error("probe boom");
        },
        buildInfo: BUILD,
      },
    });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(false);
    expect(log).toHaveBeenCalled();
  });

  it("returns the injected build info at /version (always 200)", async () => {
    const app = appWith({
      checkReadiness: async () => ({ ready: true, checks: {} }),
      buildInfo: BUILD,
    });
    const res = await app.request("/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BUILD);
  });

  it("falls back missing build fields to 'unknown'", async () => {
    const app = appWith({
      checkReadiness: async () => ({ ready: true, checks: {} }),
      buildInfo: { version: "unknown", gitSha: "unknown", builtAt: "unknown" },
    });
    const res = await app.request("/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "unknown", gitSha: "unknown", builtAt: "unknown" });
  });

  it("serves /healthz and /version without authentication", async () => {
    const app = appWith({
      checkReadiness: async () => ({ ready: true, checks: {} }),
      buildInfo: BUILD,
    });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/version")).status).toBe(200);
  });

  it("includes X-Trace-Id on both endpoints (reuses app middleware)", async () => {
    const app = appWith({
      checkReadiness: async () => ({ ready: true, checks: {} }),
      buildInfo: BUILD,
    });
    expect((await app.request("/healthz")).headers.get("X-Trace-Id")).toBeTruthy();
    expect((await app.request("/version")).headers.get("X-Trace-Id")).toBeTruthy();
  });
});
