// Virtual model-alias map (docs/04) — an operator-configured compatibility shim
// that rewrites an inbound VENDOR model id (e.g. Claude Code's "claude-opus-4-8",
// which is neither a lane nor an internal provider alias) onto a LANE name or the
// "auto" sentinel BEFORE routing. It lets a fixed-model client — Claude CLI, an
// SDK pinned to a vendor id — talk to Helm without a 400, while keeping the lane
// abstraction intact (principle 6): a virtual name resolves to a lane, NEVER to a
// raw provider/model. Targets are validated at boot (validateModelAliasTargets) to
// be a known lane or "auto" — an unknown target refuses to start (principle 2).
//
// The map is pure routing config; this module is framework-agnostic and consumed
// by route-request's plan() (the rewrite) and the gateway composition root (boot
// validation).

export type ModelAliasMap = Record<string, string>;

// Match order, given an inbound model id:
//   1. an EXACT map key wins outright;
//   2. otherwise the matching glob pattern (`*` = any run of chars, incl. empty)
//      with the most LITERAL (non-`*`) characters wins — so "claude-opus-*" beats
//      "claude-*" regardless of declaration order; ties break on declaration order.
// Case-sensitive (mirrors the eval-cache-key convention: no lowercasing). Returns
// the target string (a lane name or "auto"), or null when nothing matches.
export function resolveModelAlias(model: string, map: ModelAliasMap | undefined): string | null {
  if (map === undefined) return null;
  // 1) exact key wins — no glob scan needed.
  if (Object.hasOwn(map, model)) return map[model] as string;
  // 2) longest-literal glob. Object.entries preserves insertion order, so a tie
  //    on literal count resolves to whoever was written first (stable).
  let best: { target: string; literals: number } | null = null;
  for (const [pattern, target] of Object.entries(map)) {
    if (!pattern.includes("*")) continue; // exact patterns already handled above
    if (!globMatch(pattern, model)) continue;
    const literals = pattern.length - starCount(pattern);
    if (best === null || literals > best.literals) best = { target, literals };
  }
  return best?.target ?? null;
}

// Boot-time, fail-closed (principle 2): every alias target must be a configured
// lane or the "auto" sentinel. Returns a list of human-readable error lines (empty
// = valid). The caller throws on a non-empty list so a typo'd lane never boots.
export function validateModelAliasTargets(
  map: ModelAliasMap | undefined,
  laneNames: Iterable<string>,
): string[] {
  if (map === undefined) return [];
  const lanes = new Set(laneNames);
  const errors: string[] = [];
  for (const [pattern, target] of Object.entries(map)) {
    if (target === "auto" || lanes.has(target)) continue;
    errors.push(
      `model alias "${pattern}" -> unknown lane "${target}" (expected a lane name or "auto")`,
    );
  }
  return errors;
}

function starCount(pattern: string): number {
  let n = 0;
  for (const ch of pattern) if (ch === "*") n++;
  return n;
}

// Glob → anchored RegExp: escape every regex metachar in the pattern, then turn
// the (now-escaped) `*` back into `.*`. So the model id is matched as a literal
// string except for the wildcard — a `.` in "gpt-5.5" is a literal dot, not "any".
function globMatch(pattern: string, model: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}
