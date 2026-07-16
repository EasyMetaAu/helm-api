import {
  createBlockedModelMatcher,
  expandLaneChain,
  type LanesConfig,
  type ModelAliasMap,
  resolveModelAlias,
} from "@helm/core";

export interface ResolveCodexCompactModelInput {
  requestedModel: string;
  lanes: LanesConfig;
  modelAliases?: ModelAliasMap;
  oauthAliases: ReadonlySet<string>;
  allowCustomModel: boolean;
  allowedLanes?: readonly string[] | null;
  blockedModels?: readonly string[] | null;
}

const CODEX_PREFIX = "openai-codex/";

export function resolveCodexCompactModel(input: ResolveCodexCompactModelInput): string | null {
  if (!input.allowCustomModel || input.requestedModel.length === 0) return null;
  const aliasTarget = resolveModelAlias(input.requestedModel, input.modelAliases);
  if (aliasTarget === "auto") return null;
  const target = aliasTarget ?? input.requestedModel;
  const isLane = Object.hasOwn(input.lanes, target);
  if (isLane && input.allowedLanes != null && !input.allowedLanes.includes(target)) {
    return null;
  }
  const candidates = isLane
    ? expandLaneChain(target, input.lanes)
    : target.startsWith(CODEX_PREFIX)
      ? [target]
      : [`${CODEX_PREFIX}${target}`];
  const blocked = createBlockedModelMatcher(input.blockedModels);
  if (blocked?.matches(input.requestedModel) || blocked?.matches(target)) return null;
  for (const candidate of candidates) {
    if (!candidate.startsWith(CODEX_PREFIX)) continue;
    if (!input.oauthAliases.has(candidate) || blocked?.matches(candidate)) continue;
    return candidate.slice(CODEX_PREFIX.length);
  }
  return null;
}
