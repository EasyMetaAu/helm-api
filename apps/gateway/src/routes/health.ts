import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import type { BuildInfo } from "../build-info.js";

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, "ok" | "fail">;
}

export interface HealthDeps {
  // Readiness probe: aggregates whether key dependencies are ready (e.g. Store
  // reachable). MVP may inject an always-true probe; the signature is reserved.
  checkReadiness: () => Promise<ReadinessResult>;
  buildInfo: BuildInfo;
}

// Register GET /healthz and GET /version on the given app (does not create one).
// Both are unauthenticated, zero external hard-dependency, low-latency. /healthz
// returns 503 when not ready (or the probe throws) so orchestrators drain traffic.
export function registerHealthRoutes(app: Hono<AppEnv>, deps: HealthDeps): void {
  app.get("/healthz", async (c) => {
    let result: ReadinessResult;
    try {
      result = await deps.checkReadiness();
    } catch {
      // Probe failure is fail-closed: report not-ready (503), never 500/hang.
      c.get("logger").log("error", "healthz.probe_failed", { trace_id: c.get("trace_id") });
      return c.json({ status: "degraded", ready: false, checks: { probe: "fail" } }, 503);
    }
    if (!result.ready) {
      return c.json({ status: "degraded", ready: false, checks: result.checks }, 503);
    }
    return c.json({ status: "ok", ready: true, checks: result.checks }, 200);
  });

  app.get("/version", (c) => {
    return c.json(deps.buildInfo, 200);
  });
}
