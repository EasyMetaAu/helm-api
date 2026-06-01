// Build a "contains" LIKE/ILIKE pattern from untrusted user input. The model
// search filter feeds straight from the Debug UI, so a literal `%` or `_` in the
// query must NOT act as a wildcard (it would silently widen the match). We escape
// the LIKE metacharacters with a backslash; callers pair this with `ESCAPE '\'`.
export function likeContains(value: string): string {
  const escaped = value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}
