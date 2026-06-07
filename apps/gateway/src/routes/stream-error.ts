import { UpstreamError } from "@helm/core";

// Shared classification for a throw caught WHILE forwarding an SSE stream.
//
// The provider inter-chunk idle guard (provider/stream-idle.ts) throws
// UpstreamError("timeout") when an upstream goes silent mid-stream — i.e. AFTER
// headers / the first chunk, where a fallback is no longer possible. Each
// streaming route maps a PipelineError to its carried error_class but flattens any
// OTHER throw to a generic class (upstream_error / internal_error). That flatten
// would erase the timeout signal exactly where this guard makes it observable, so
// the routes special-case it via this predicate to keep the terminal error frame
// honest (error_class === "timeout").
export function isUpstreamTimeout(err: unknown): boolean {
  return err instanceof UpstreamError && err.errorClass === "timeout";
}
