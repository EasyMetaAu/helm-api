import { TokenRefreshError, UpstreamError } from "@helm/core";

export function isPermanentOAuthCredentialFailure(err: unknown): boolean {
  if (err instanceof TokenRefreshError) {
    if (err.permanentCredentialFailure) return true;
    return err.httpStatus === 400 || err.httpStatus === 401 || err.httpStatus === 403;
  }
  if (err instanceof UpstreamError) {
    return err.upstreamStatus === 401 || err.upstreamStatus === 403;
  }
  return false;
}

export function oauthCredentialFailureReason(err: unknown): string {
  return err instanceof Error ? err.message : "oauth credential failed";
}
