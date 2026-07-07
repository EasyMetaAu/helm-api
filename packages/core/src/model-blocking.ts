export interface BlockedModelMatcher {
  matches(model: string): boolean;
}

export function createBlockedModelMatcher(
  blockedModels: readonly string[] | null | undefined,
): BlockedModelMatcher | null {
  if (!Array.isArray(blockedModels) || blockedModels.length === 0) return null;

  const exact = new Set<string>();
  const wildcard: RegExp[] = [];

  for (const raw of blockedModels) {
    const pattern = raw.trim();
    if (pattern.length === 0) continue;
    if (containsWildcard(pattern)) wildcard.push(globToRegExp(pattern));
    else exact.add(pattern.toLowerCase());
  }

  if (exact.size === 0 && wildcard.length === 0) return null;

  return {
    matches(model: string): boolean {
      if (exact.has(model.toLowerCase())) return true;
      return wildcard.some((pattern) => pattern.test(model));
    },
  };
}

function containsWildcard(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += escapeRegExpChar(ch);
  }
  source += "$";
  return new RegExp(source, "iu");
}

function escapeRegExpChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(ch) ? `\\${ch}` : ch;
}
