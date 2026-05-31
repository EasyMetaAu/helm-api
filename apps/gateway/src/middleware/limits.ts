import { makeHelmError } from "@helm/shared";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";
import { HelmHttpError } from "./error-handler.js";

export interface LimitsConfig {
  maxBodyBytes: number;
  requestTimeoutMs: number;
}

function tooLarge(traceId: string): HelmHttpError {
  return new HelmHttpError(
    makeHelmError({
      error_class: "invalid_request",
      message: "request body too large",
      trace_id: traceId,
    }),
  );
}

// Body size limit. Prefers Content-Length; falls back to counting actual stream
// bytes so a small declared length cannot smuggle a large body. Over limit ->
// invalid_request(400) via onError.
export function bodyLimit(cfg: LimitsConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const traceId = c.get("trace_id");
    const declared = c.req.header("Content-Length");
    if (declared !== undefined) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > cfg.maxBodyBytes) {
        throw tooLarge(traceId);
      }
    }
    // Stream-count fallback: buffer the body, enforce the real byte count, and
    // re-attach it so downstream handlers can still read it.
    const raw = c.req.raw;
    if (raw.body) {
      const buf = new Uint8Array(await raw.clone().arrayBuffer());
      if (buf.byteLength > cfg.maxBodyBytes) {
        throw tooLarge(traceId);
      }
    }
    await next();
  };
}

// Overall request timeout. Aborts downstream work via an AbortController and maps
// to timeout(504). A client-initiated disconnect is NOT a timeout: if the
// client's own signal aborted, we do not synthesize a 504.
export function timeout(cfg: LimitsConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const traceId = c.get("trace_id");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    try {
      await Promise.race([
        next(),
        new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => {
            // Client disconnect is not a server timeout.
            if (c.req.raw.signal.aborted) return;
            reject(
              new HelmHttpError(
                makeHelmError({
                  error_class: "timeout",
                  message: "request timed out",
                  trace_id: traceId,
                }),
              ),
            );
          });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
