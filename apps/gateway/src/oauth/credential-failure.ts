import { TokenRefreshError, UpstreamError } from "@helm/core";

export function isPermanentOAuthCredentialFailure(err: unknown): boolean {
  if (err instanceof TokenRefreshError) {
    return err.permanentCredentialFailure;
  }
  if (err instanceof UpstreamError) {
    return err.upstreamStatus === 401;
  }
  return false;
}

export function oauthCredentialFailureReason(err: unknown): string {
  return err instanceof Error ? err.message : "oauth credential failed";
}
