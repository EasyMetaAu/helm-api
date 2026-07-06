import type { CatalogEntry, ModelObject, ModelsList } from "@helm/shared";
import { expandLaneChain } from "../lanes/expand-chain.js";
import type { LanesConfig } from "../lanes/schema.js";

// buildModelsList — the pure data builder behind GET /v1/models. Framework-free
// (principle 1): the gateway route serializes the result; this module decides
// WHAT a given key may see, honoring principle 6 (lanes are the public face; a
// concrete provider alias is supply-chain detail) and principle 7 (lanes never
// leak pricing/capabilities).
//
//   • Default key  → lanes (config order) + the `auto` directive. Nothing else.
//   • allow_custom_model key → the above, PLUS every configured provider alias
//     (sorted) enriched with catalog capabilities/pricing and the set of lanes
//     that can route to it. Those keys already bypass the lane abstraction, so
//     exposing the aliases they can name is consistent, not a leak.
//   • allowedLanes (per-key cap) restricts which lanes are visible AND the lane
//     membership reported for each alias — the listing reflects what the key can
//     actually use, never more.

// The OpenAI model object requires a `created` timestamp; Helm has no per-model
// creation date, so a stable constant is used (clients only need the field).
const CREATED = 0;
// The "let the router decide" directive — a first-class selectable id, not a lane.
const AUTO_ID = "auto";
const OWNER_HELM = "helm";

export interface BuildModelsListInput {
  lanes: LanesConfig;
  /** Capability/pricing metadata keyed by model alias (loadRuntimeCatalog). */
  catalog: Map<string, CatalogEntry>;
  /** Configured provider aliases: config.providers[].models[].alias. */
  providerAliases: string[];
  /** The authenticated key's allow_custom_model cap. */
  allowCustomModel: boolean;
  /** The key's allowed_lanes cap; null/undefined = unconstrained. */
  allowedLanes?: string[] | null;
  /** Exact concrete aliases hidden from and unavailable to this key. */
  blockedModels?: string[] | null;
}

// Provider name an alias is owned by: the prefix before the first "/" (e.g.
// "deepseek/pro" → "deepseek"). Falls back to the whole id if unprefixed.
function ownerOf(alias: string): string {
  const slash = alias.indexOf("/");
  return slash > 0 ? alias.slice(0, slash) : alias;
}

export function buildModelsList(input: BuildModelsListInput): ModelsList {
  const { lanes, catalog, providerAliases, allowCustomModel } = input;

  const blocked = new Set(input.blockedModels ?? []);
  const laneHasVisibleCandidate = (name: string): boolean =>
    expandLaneChain(name, lanes).some((alias) => !blocked.has(alias));

  // Visible lanes: config (insertion) order, narrowed by the key's allowed_lanes
  // and by the key's blocked_models. A lane whose entire expanded chain is
  // blocked is not actually usable by this key, so do not advertise it.
  const allowed = input.allowedLanes ?? null;
  const visibleLanes = Object.keys(lanes).filter(
    (name) => (allowed === null || allowed.includes(name)) && laneHasVisibleCandidate(name),
  );

  const data: ModelObject[] = [];

  // 1) Lane entries (the public abstraction) — no pricing/capabilities.
  for (const name of visibleLanes) {
    data.push({
      id: name,
      object: "model",
      created: CREATED,
      owned_by: OWNER_HELM,
      type: "lane",
      lanes: [name],
    });
  }

  // 2) The `auto` directive — always selectable; the router picks within the
  //    key's allowed lanes. Carries no lane membership.
  data.push({
    id: AUTO_ID,
    object: "model",
    created: CREATED,
    owned_by: OWNER_HELM,
    type: "lane",
  });

  // 3) Concrete aliases — only for keys allowed to name a model directly.
  if (allowCustomModel) {
    // Precompute alias → visible lanes that can route to it, by expanding each
    // visible lane's chain to its leaf aliases once.
    const membership = new Map<string, string[]>();
    for (const name of visibleLanes) {
      for (const alias of expandLaneChain(name, lanes)) {
        const arr = membership.get(alias);
        if (arr) arr.push(name);
        else membership.set(alias, [name]);
      }
    }

    const uniqueAliases = [...new Set(providerAliases)]
      .filter((alias) => !blocked.has(alias))
      .sort((a, b) => a.localeCompare(b));
    for (const alias of uniqueAliases) {
      const meta = catalog.get(alias);
      data.push({
        id: alias,
        object: "model",
        created: CREATED,
        owned_by: ownerOf(alias),
        type: "model",
        lanes: membership.get(alias) ?? [],
        ...(meta ? { capabilities: meta.capabilities, pricing: meta.pricing } : {}),
      });
    }
  }

  return { object: "list", data };
}
