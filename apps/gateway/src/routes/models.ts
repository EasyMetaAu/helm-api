import type { LanesConfig, OpenAICodexModelsResult } from "@helm/core";
import { buildModelsList } from "@helm/core";
import { type CatalogEntry, makeHelmError } from "@helm/shared";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import { HelmHttpError } from "../middleware/error-handler.js";
import { requestSignal } from "../middleware/limits.js";
import { normalizeOpenAICodexClientVersion } from "../oauth/codex-client-version.js";

// GET /v1/models — OpenAI-compatible model discovery. Behind API-key auth (mounted
// in server.ts) so the listing is KEY-AWARE: the authenticated identity's
// allow_custom_model + allowed_lanes caps decide what buildModelsList returns
// (lanes always; concrete aliases only for keys that may name a model). Pure
// presentation glue — all policy lives in core (principle 1).
export interface ModelsRouteDeps {
  // Live lanes thunk: admin edits rebind the router's lanes at runtime, so read
  // it per request rather than capturing a snapshot.
  lanes: () => LanesConfig;
  // Capability/pricing catalog (loadRuntimeCatalog), immutable for the process.
  catalog: Map<string, CatalogEntry>;
  // Configured provider aliases: config.providers[].models[].alias.
  providerAliases: string[];
  // Live curated subscription (OAuth) aliases — `<provider>/<model>` ids synthesized
  // from bound credentials, not config. Hot-reloadable (admin curation / connect /
  // disconnect), so read per request like `lanes` rather than snapshotted. Optional:
  // absent in headless/no-OAuth deployments. These are concrete aliases, so — like
  // providerAliases — they surface only for allow_custom_model keys (buildModelsList).
  oauthAliases?: () => Iterable<string>;
  // Codex CLI content negotiation. Supplying `client_version` requests the native
  // `{models: ModelInfo[]}` envelope instead of the OpenAI-compatible list. The
  // callback receives the authenticated key caps so native discovery and compact
  // enforce the same entitlement boundary.
  codexModels?: (input: {
    clientVersion: string;
    allowCustomModel: boolean;
    allowedLanes: readonly string[] | null;
    blockedModels: readonly string[] | null;
    signal: AbortSignal;
  }) => OpenAICodexModelsResult | null | Promise<OpenAICodexModelsResult | null>;
  codexModelsTimeoutMs?: number;
  // Records the exact key-filtered ETag returned to Codex CLI. Responses can then
  // replace the upstream account-wide ETag with this same key-scoped value.
  onCodexModelsListed?: (keyId: string, clientVersion: string, etag: string) => void;
}

// ponytail: 30s TTL memo, per caps-fingerprint. A misbehaving client (seen in
// prod: a codex_exec retry loop hammering GET /v1/models ~1/s) otherwise re-runs
// buildModelsList — lane walk + oauth-alias merge + dedup/sort — on every hit.
// The listing depends only on slow-moving inputs (key caps, lanes, oauth aliases),
// so a short TTL absorbs the flood; admin edits to lanes/curation take effect
// within TTL_MS. Bounded to CAP entries (distinct caps shapes are few); a full
// bucket just skips caching that request rather than growing unbounded.
const TTL_MS = 30_000;
const CACHE_CAP = 256;

export function registerModelsRoute(app: Hono<AppEnv>, deps: ModelsRouteDeps): void {
  const cache = new Map<string, { at: number; value: ReturnType<typeof buildModelsList> }>();

  const build = (c: Context<AppEnv>) => {
    const identity = c.get("identity");
    const caps = identity.caps;
    // Fingerprint the only inputs that vary the output: the key's caps. lanes /
    // oauth aliases are process-wide, so TTL alone (not the key) covers their drift.
    const fp = `${caps.allowCustomModel ? 1 : 0}|${JSON.stringify(caps.allowedLanes)}|${JSON.stringify(caps.blockedModels)}`;
    const now = Date.now();
    const hit = cache.get(fp);
    if (hit && now - hit.at < TTL_MS) return hit.value;

    // Merge static config aliases with the LIVE subscription set. buildModelsList
    // dedups + sorts, so an alias that is both configured and OAuth-curated lists once.
    const oauth = deps.oauthAliases ? [...deps.oauthAliases()] : [];
    const value = buildModelsList({
      lanes: deps.lanes(),
      catalog: deps.catalog,
      providerAliases: oauth.length ? [...deps.providerAliases, ...oauth] : deps.providerAliases,
      allowCustomModel: caps.allowCustomModel,
      allowedLanes: caps.allowedLanes,
      blockedModels: caps.blockedModels,
    });
    if (cache.size < CACHE_CAP || cache.has(fp)) cache.set(fp, { at: now, value });
    return value;
  };

  app.get("/v1/models", async (c) => {
    const rawClientVersion = c.req.query("client_version");
    if (rawClientVersion !== undefined && deps.codexModels !== undefined) {
      const clientVersion = normalizeOpenAICodexClientVersion(rawClientVersion);
      if (clientVersion === null) {
        throw new HelmHttpError(
          makeHelmError({
            error_class: "invalid_request",
            message: "client_version must be a valid semantic version",
            trace_id: c.get("trace_id"),
          }),
        );
      }
      const caps = c.get("identity").caps;
      const timeoutMs = Math.max(1, deps.codexModelsTimeoutMs ?? 5_000);
      const result = await deps.codexModels({
        clientVersion,
        allowCustomModel: caps.allowCustomModel,
        allowedLanes: caps.allowedLanes,
        blockedModels: caps.blockedModels,
        signal: AbortSignal.any([requestSignal(c), AbortSignal.timeout(timeoutMs)]),
      });
      if (result?.etag !== undefined) {
        c.header("ETag", result.etag);
        deps.onCodexModelsListed?.(c.get("identity").keyId, clientVersion, result.etag);
      }
      if (result?.reasoningIncluded === true) {
        c.header("x-reasoning-included", "true");
      }
      return c.json({ models: result?.models ?? [] }, 200);
    }
    return c.json(build(c), 200);
  });

  // Retrieve a single model the key can use. An id outside the key's listing is
  // reported as invalid_request (the structured error taxonomy has no 404 class);
  // the OpenAI envelope is rendered by the global handler.
  app.get("/v1/models/:id", (c) => {
    const id = c.req.param("id");
    const model = build(c).data.find((m) => m.id === id);
    if (!model) {
      throw new HelmHttpError(
        makeHelmError({
          error_class: "invalid_request",
          message: `model '${id}' not found or not available to this key`,
          trace_id: c.get("trace_id"),
        }),
      );
    }
    return c.json(model, 200);
  });
}
