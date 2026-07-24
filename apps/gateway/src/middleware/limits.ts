import { makeHelmError } from "@helm/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";
import { REQUEST_TIMEOUT_REASON } from "../request-cancellation.js";
import { HelmHttpError } from "./error-handler.js";

export interface LimitsConfig {
  requestTimeoutMs: number;
}

export interface RequestTimeoutState {
  signal: AbortSignal;
  timedOut: boolean;
}

export function requestSignal(c: Context<AppEnv>): AbortSignal {
  return c.get("concurrency_signal") ?? c.get("request_timeout")?.signal ?? c.req.raw.signal;
}

export function requestTimedOut(c: Context<AppEnv>): boolean {
  return c.get("request_timeout")?.timedOut === true;
}

// Overall request timeout. Aborts downstream work via an AbortController and maps
// to timeout(504). A client-initiated disconnect is NOT a timeout: if the
// client's own signal aborted, we do not synthesize a 504.
export function timeout(cfg: LimitsConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const traceId = c.get("trace_id");
    const controller = new AbortController();
    const state: RequestTimeoutState = {
      signal: AbortSignal.any([c.req.raw.signal, controller.signal]),
      timedOut: false,
    };
    c.set("request_timeout", state);
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort(REQUEST_TIMEOUT_REASON);
    }, cfg.requestTimeoutMs);
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
    } catch (error) {
      clearTimeout(timer);
      // The downstream abort listener can reject in the same turn as the timeout
      // promise. Keep the timeout classification authoritative instead of letting
      // that race surface a generic AbortError/client-abort 499.
      if (state.timedOut && !c.req.raw.signal.aborted) {
        throw new HelmHttpError(
          makeHelmError({
            error_class: "timeout",
            message: "request timed out",
            trace_id: traceId,
          }),
        );
      }
      throw error;
    }

    if (state.timedOut && !c.req.raw.signal.aborted) {
      clearTimeout(timer);
      throw new HelmHttpError(
        makeHelmError({
          error_class: "timeout",
          message: "request timed out",
          trace_id: traceId,
        }),
      );
    }

    const response = c.res;
    if (response.body === null) {
      clearTimeout(timer);
      return;
    }
    const reader = response.body.getReader();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reader.releaseLock();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            streamController.close();
          } else {
            streamController.enqueue(chunk.value);
          }
        } catch (error) {
          finish();
          streamController.error(error);
        }
      },
      async cancel(reason) {
        clearTimeout(timer);
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
    c.res = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
