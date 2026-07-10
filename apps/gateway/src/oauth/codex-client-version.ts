export const MAX_OPENAI_CODEX_CLIENT_VERSION_LENGTH = 64;

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function normalizeOpenAICodexClientVersion(value: string): string | null {
  if (value.length > MAX_OPENAI_CODEX_CLIENT_VERSION_LENGTH) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OPENAI_CODEX_CLIENT_VERSION_LENGTH) return null;
  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match) return null;

  const prerelease = match[4];
  if (
    prerelease
      ?.split(".")
      .some(
        (identifier) =>
          /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
      )
  ) {
    return null;
  }

  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}
