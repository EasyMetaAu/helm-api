import type { MiddlewareHandler } from "hono";

// Deterministic pre-classification token estimate for the TPM bucket. Reads the
// declared body size from the Content-Length header — a SYNC header read that
// NEVER consumes the request body stream, so the downstream route can still parse
// it. The heuristic is ceil(bytes / 4): ~4 bytes per token, the standard rough
// BPE ratio (deterministic, principle 4). It is intentionally conservative — a
// pre-debit upper bound is acceptable for a TPM ceiling, and a request with no
// Content-Length (chunked / unknown) estimates 0 (RPM still applies). A malformed
// or negative header value clamps to 0, never NaN/negative (would corrupt the
// bucket). Lives in its own module so BOTH the OpenAI chat middleware AND the
// self-authenticating Anthropic /v1/messages + OpenAI /v1/responses routes share
// the SAME estimator (they each call the limiter directly), without a circular
// import through server.ts.
export function estimateRequestTokens(c: Parameters<MiddlewareHandler>[0]): number {
  const raw = c.req.header("content-length");
  if (raw === undefined) return 0;
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}
