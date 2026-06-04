import type { LanesConfig } from "./schema.js";

// Expand a selected lane into an ordered candidate chain of MODEL ALIASES. Each
// primary/fallback element may name a model alias OR another lane (docs/04). Lane
// references are expanded recursively; model aliases are appended. Dedup keeps
// first occurrence; a `visited` set bounds recursion so `a→b→a` cannot loop.
//
// Pure, deterministic, zero-network (principle 4). This is the EXECUTION-fallback
// chain shape — the same expansion the router feeds executor.fallback — extracted
// here so it has one definition shared by routing (route-request) and the public
// model listing (catalog/models-list). It does NOT trip breakers or filter by
// capability; it only flattens the declarative lane graph to leaf aliases.
export function expandLaneChain(laneName: string, lanes: LanesConfig): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();

  const push = (alias: string): void => {
    if (!seen.has(alias)) {
      seen.add(alias);
      chain.push(alias);
    }
  };

  const visit = (name: string, visitedLanes: Set<string>): void => {
    if (visitedLanes.has(name)) return; // cycle guard
    visitedLanes.add(name);
    const lane = lanes[name];
    if (lane === undefined) {
      // Not a lane → it is a model alias; append it.
      push(name);
      return;
    }
    // Lane: primary then fallback, each possibly a lane or an alias.
    const elements = [lane.primary, ...lane.fallback];
    for (const el of elements) {
      if (Object.hasOwn(lanes, el)) {
        visit(el, visitedLanes);
      } else {
        push(el);
      }
    }
  };

  visit(laneName, new Set<string>());
  return chain;
}
