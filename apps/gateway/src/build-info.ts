// Build information, injected at build time via env. Missing fields fall back to
// "unknown" — never throws. Exposes version/sha/build-time only, no config/creds.

export interface BuildInfo {
  version: string;
  gitSha: string;
  builtAt: string;
}

export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    version: env.HELM_VERSION ?? "unknown",
    gitSha: env.HELM_GIT_SHA ?? "unknown",
    builtAt: env.HELM_BUILT_AT ?? "unknown",
  };
}
