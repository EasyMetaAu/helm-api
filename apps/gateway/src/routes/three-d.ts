import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { registerMediaTaskRoutes, type VideosRouteDeps } from "./videos.js";

/** Resolver client.create/retrieve must bind threeDGeneration/threeDRetrieve. */
export type ThreeDRouteDeps = VideosRouteDeps;
export function registerThreeDRoute(app: Hono<AppEnv>, deps: ThreeDRouteDeps): void {
  registerMediaTaskRoutes(app, deps, "three-d");
}
