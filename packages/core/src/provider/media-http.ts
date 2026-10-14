import OpenAI from "openai";
import { z } from "zod";
import {
  consumeResponseTextWithinBudget,
  ResponseBodyTooLargeError,
} from "../runtime/bounded-response.js";
import {
  ResponseWorkCapacityError,
  runtimeResponseWorkAdmission,
} from "../runtime/response-work-admission.js";
import { redact } from "../telemetry/redaction.js";
import {
  type OpenAIClientDeps,
  type ProviderCallOptions,
  safeUpstreamHeaders,
  UPSTREAM_ERROR_BODY_MAX_BYTES,
  UpstreamError,
} from "./openai.js";

export type MediaHttpOutcome = "not_sent" | "rejected" | "unknown";
/** Never retry an unknown paid-write outcome, including malformed HTTP 200 responses. */
export class MediaHttpError extends UpstreamError {
  constructor(
    readonly outcome: MediaHttpOutcome,
    errorClass: "upstream_error" | "timeout",
    message: string,
    raw: unknown = null,
    status: number | null = null,
    headers: Record<string, string> | null = null,
  ) {
    super(errorClass, message, raw, status, headers);
    this.name = "MediaHttpError";
  }
}
class MediaAbortError extends Error {
  constructor(readonly outcome: MediaHttpOutcome) {
    super("Media request cancelled");
    this.name = "AbortError";
  }
}
export function parseMediaInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    // Zod errors may include user-provided values; expose only the contract failure.
    throw new MediaHttpError("not_sent", "upstream_error", "Unsupported or invalid media request", {
      error: { code: "invalid_request" },
    });
  }
}
export function mediaTaskPath(id: string): string {
  return parseMediaInput(() =>
    encodeURIComponent(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .max(256)
        .parse(id),
    ),
  );
}
export function mediaBaseUrl(raw: string, profile: "bailian" | "minimax"): URL {
  const base = new URL(raw);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname.replace(/\/+$/, "") !== (profile === "bailian" ? "/api/v1" : "")
  ) {
    throw new Error("Media base URL does not match its native protocol profile");
  }
  return base;
}

/** The two native protocols share only bounded JSON transport, never their wire schemas. */
export function createMediaHttpTransport(deps: OpenAIClientDeps, profile: "bailian" | "minimax") {
  const cfg = deps.config;
  if ((cfg.apiKey !== undefined) === (cfg.getAuthHeader !== undefined) || cfg.apiKey?.trim() === "")
    throw new Error("Media provider requires exactly one non-empty credential source");
  mediaBaseUrl(cfg.baseUrl, profile);
  const timeoutMs = cfg.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
    throw new Error("Media provider timeout must be positive and fit a platform timer");
  const doFetch = deps.fetch ?? globalThis.fetch;
  const admission = deps.responseWorkAdmission ?? runtimeResponseWorkAdmission();

  return async function call(
    args: {
      path: string;
      body?: Record<string, unknown>;
      sdkImage?: boolean;
      compatible?: boolean;
      asyncTask?: boolean;
      parse: (value: unknown) => Record<string, unknown>;
      /** Explicit API rejection. Task failures in output/task are valid poll results. */
      isRejection?: (value: Record<string, unknown>) => boolean;
    },
    opts?: ProviderCallOptions,
  ): Promise<Record<string, unknown>> {
    let sent = false;
    let status: number | null = null;
    let responseHeaders: Record<string, string> | null = null;
    let boundaryError: unknown;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
    const outcome = (): MediaHttpOutcome => (sent ? "unknown" : "not_sent");
    const secrets = new Set<string>(cfg.apiKey ? [cfg.apiKey] : []);
    const scrubString = (value: string) => {
      for (const secret of secrets) if (secret) value = value.split(secret).join("[redacted]");
      return value;
    };
    const scrub = (value: unknown): unknown => {
      if (typeof value === "string") return scrubString(value);
      if (Array.isArray(value)) return value.map(scrub);
      if (value !== null && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [scrubString(key), scrub(entry)]),
        );
      return value;
    };
    const failure = (code: string, message: string) =>
      new MediaHttpError(
        outcome(),
        "upstream_error",
        message,
        { error: { code } },
        status,
        responseHeaders,
      );
    function mapError(error: unknown): MediaHttpError {
      if (error instanceof MediaHttpError) return error;
      if (error instanceof ResponseBodyTooLargeError)
        return failure("response_body_too_large", error.message);
      if (error instanceof ResponseWorkCapacityError)
        return failure("response_work_capacity_exhausted", error.message);
      return failure("transport_failure", "Media transport failed");
    }
    // Also bounds asynchronous credentials/resolvers and injected fetch implementations.
    async function abortable<T>(promise: Promise<T>): Promise<T> {
      signal.throwIfAborted();
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        return await Promise.race([promise, cancelled]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
    try {
      signal.throwIfAborted();
      const base = mediaBaseUrl(
        cfg.resolveBaseUrl ? await abortable(cfg.resolveBaseUrl()) : cfg.baseUrl,
        profile,
      );
      const baseURL =
        args.sdkImage || args.compatible
          ? `${base.origin}/compatible-mode/v1`
          : base.toString().replace(/\/+$/, "");
      const target = `${baseURL}${args.path}`;
      const authorization = cfg.getAuthHeader
        ? await abortable(cfg.getAuthHeader())
        : `Bearer ${cfg.apiKey}`;
      if (!authorization.trim())
        throw failure("invalid_credential", "Provider credential is empty");
      secrets.add(authorization);
      secrets.add(authorization.replace(/^Bearer\s+/i, ""));
      for (const secret of cfg.currentSecrets?.() ?? []) secrets.add(secret);
      const headers = new Headers(cfg.extraHeaders?.());
      headers.set("authorization", authorization);
      headers.set("content-type", "application/json");
      if (args.asyncTask) headers.set("x-dashscope-async", "enable");
      else headers.delete("x-dashscope-async");

      const boundedFetch: typeof globalThis.fetch = async (url, init) => {
        signal.throwIfAborted();
        if (String(url) !== target)
          throw failure(
            "unexpected_target",
            "Media request target differs from configured endpoint",
          );
        if (typeof init?.body === "string") {
          try {
            opts?.captureUpstream?.(init.body);
          } catch {
            /* fail-open observer */
          }
        }
        signal.throwIfAborted();
        sent = true;
        const pending = doFetch(url, { ...init, signal, redirect: "manual" });
        // If an injected fetch ignores abort and resolves late, discard its body.
        void pending.then(
          (res) => {
            if (signal.aborted) void res.body?.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await abortable(pending);
        status = response.status;
        responseHeaders = scrub(safeUpstreamHeaders(response.headers)) as Record<string, string>;
        try {
          opts?.onResponseMeta?.(new Headers(responseHeaders));
        } catch {
          /* fail-open observer */
        }
        if (!response.ok) {
          try {
            const raw = await consumeResponseTextWithinBudget(
              response,
              Math.min(admission.capacityBytes, UPSTREAM_ERROR_BODY_MAX_BYTES),
              (text) => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(text);
                } catch {
                  parsed = text;
                }
                return scrub(redact(parsed, { payloadKeys: [] }));
              },
              admission,
              signal,
            );
            boundaryError = new MediaHttpError(
              status >= 400 && status < 500 && status !== 408 ? "rejected" : "unknown",
              "upstream_error",
              `Media upstream returned HTTP ${status}`,
              raw,
              status,
              responseHeaders,
            );
          } catch (error) {
            boundaryError = mapError(error);
          }
          // Stop SDK error parsing before it can perform an unbounded response.text().
          throw boundaryError;
        }
        return response;
      };
      let response: Response;
      if (args.sdkImage) {
        const sdk = new OpenAI({
          apiKey: "helm-runtime-auth",
          baseURL,
          organization: null,
          project: null,
          maxRetries: 0,
          timeout: timeoutMs,
          logLevel: "off",
          fetch: boundedFetch,
        });
        response = await sdk.images
          .generate(args.body as unknown as OpenAI.Images.ImageGenerateParamsNonStreaming, {
            headers,
            signal,
            maxRetries: 0,
          })
          .asResponse();
      } else {
        response = await boundedFetch(target, {
          method: args.body === undefined ? "GET" : "POST",
          headers,
          body: args.body === undefined ? undefined : JSON.stringify(args.body),
        });
      }
      return await consumeResponseTextWithinBudget(
        response,
        Math.min(admission.capacityBytes, 16 * 1024 * 1024),
        (text) => {
          let raw: Record<string, unknown>;
          try {
            raw = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
          } catch {
            throw failure("invalid_response", "Media upstream returned invalid JSON");
          }
          if (args.isRejection?.(raw))
            throw new MediaHttpError(
              "rejected",
              "upstream_error",
              "Media upstream rejected the request",
              scrub(redact(raw, { payloadKeys: [] })),
              status,
              responseHeaders,
            );
          try {
            return args.parse(raw);
          } catch {
            // Preserve bounded, scrubbed evidence (especially a known upstream task ID)
            // for recovery when the acceptance envelope is malformed. Never resend it.
            throw new MediaHttpError(
              outcome(),
              "upstream_error",
              "Media upstream response does not match its protocol",
              {
                error: { code: "invalid_response" },
                response: scrub(redact(raw, { payloadKeys: [] })),
              },
              status,
              responseHeaders,
            );
          }
        },
        admission,
        signal,
      );
    } catch (error) {
      if (opts?.signal?.aborted) throw new MediaAbortError(outcome());
      if (timeout.signal.aborted)
        throw new MediaHttpError(
          outcome(),
          "timeout",
          "Media request timed out",
          { error: { code: "upstream_timeout" } },
          status,
          responseHeaders,
        );
      throw mapError(boundaryError ?? error);
    } finally {
      clearTimeout(timer);
    }
  };
}
