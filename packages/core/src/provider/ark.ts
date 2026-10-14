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

const RecordSchema = z.record(z.string(), z.unknown());
export type ArkMediaOutcome = "not_sent" | "rejected" | "unknown";

/** An unknown paid-write outcome must never be retried or sent to a fallback. */
export class ArkMediaError extends UpstreamError {
  constructor(
    readonly outcome: ArkMediaOutcome,
    errorClass: "upstream_error" | "timeout",
    message: string,
    providerRaw: unknown = null,
    upstreamStatus: number | null = null,
    upstreamHeaders: Record<string, string> | null = null,
  ) {
    super(errorClass, message, providerRaw, upstreamStatus, upstreamHeaders);
    this.name = "ArkMediaError";
  }
}

class ArkMediaAbortError extends Error {
  constructor(readonly outcome: ArkMediaOutcome) {
    super("Ark media request cancelled");
    this.name = "AbortError";
  }
}

/** Transport only: public schemas, model policy, task ownership and billing live upstream. */
export function createArkMediaClient(deps: OpenAIClientDeps) {
  const cfg = deps.config;
  if ((cfg.apiKey !== undefined) === (cfg.getAuthHeader !== undefined)) {
    throw new Error("provider client requires exactly one of `apiKey` or `getAuthHeader`");
  }
  if (cfg.apiKey !== undefined && cfg.apiKey.trim().length === 0) {
    throw new Error("Ark provider credential must not be empty");
  }
  const timeoutMs = cfg.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Ark provider timeout must be positive and finite");
  }
  // HTTP proxy / connection policy is injected by the existing provider factory.
  const doFetch = deps.fetch ?? globalThis.fetch;

  async function call(
    kind: "image" | "create" | "retrieve",
    input: Record<string, unknown> | string,
    opts?: ProviderCallOptions,
  ): Promise<Record<string, unknown>> {
    let sent = false;
    let boundaryError: ArkMediaError | undefined;
    let responseStatus: number | null = null;
    let responseHeaders: Record<string, string> | null = null;
    const secrets = new Set<string>(cfg.apiKey ? [cfg.apiKey] : []);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
    const outcome = (): ArkMediaOutcome => (sent ? "unknown" : "not_sent");
    const scrubString = (text: string): string => {
      for (const secret of secrets) {
        if (secret.length > 0) text = text.split(secret).join("[redacted]");
      }
      return text;
    };
    const scrub = (raw: unknown): unknown => {
      if (typeof raw === "string") return scrubString(raw);
      if (Array.isArray(raw)) return raw.map(scrub);
      if (raw !== null && typeof raw === "object") {
        return Object.fromEntries(
          Object.entries(raw).map(([key, value]) => [scrubString(key), scrub(value)]),
        );
      }
      return raw;
    };
    const error = (code: string, message: string, raw?: unknown): ArkMediaError =>
      new ArkMediaError(
        outcome(),
        "upstream_error",
        message,
        raw ?? { error: { code } },
        responseStatus,
        responseHeaders,
      );
    const admission = deps.responseWorkAdmission ?? runtimeResponseWorkAdmission();

    try {
      signal.throwIfAborted();
      if (typeof input === "string" && (input.length === 0 || input === "." || input === "..")) {
        throw error("invalid_task_id", "Ark task ID must be a non-empty path segment");
      }
      if (typeof input !== "string" && input.stream === true) {
        throw error("unsupported_stream", "Ark media transport requires a non-streaming request");
      }
      const base = new URL(cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl);
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      ) {
        throw error(
          "invalid_base_url",
          "Ark base URL must be an HTTP endpoint without credentials, query or fragment",
        );
      }
      const baseURL = base.toString().replace(/\/+$/, "");
      const path =
        kind === "image"
          ? "/images/generations"
          : `/contents/generations/tasks${typeof input === "string" ? `/${encodeURIComponent(input)}` : ""}`;
      const target = `${baseURL}${path}`;
      const authorization = cfg.getAuthHeader ? await cfg.getAuthHeader() : `Bearer ${cfg.apiKey}`;
      if (!authorization.trim())
        throw error("invalid_credential", "Ark provider credential must not be empty");
      secrets.add(authorization);
      secrets.add(authorization.replace(/^Bearer\s+/i, ""));
      for (const secret of cfg.currentSecrets?.() ?? []) secrets.add(secret);
      const headers = new Headers(cfg.extraHeaders?.());
      // Runtime authorization is authoritative even if extraHeaders contains a stale bearer.
      headers.set("authorization", authorization);
      signal.throwIfAborted();
      const client = new OpenAI({
        apiKey: "helm-runtime-auth",
        baseURL,
        organization: null,
        project: null,
        maxRetries: 0,
        timeout: timeoutMs,
        logLevel: "off",
        fetch: async (url, init) => {
          signal.throwIfAborted();
          if (String(url) !== target)
            throw error(
              "unexpected_target",
              "Ark SDK request target differs from the configured endpoint",
            );
          if (typeof init?.body === "string") {
            try {
              opts?.captureUpstream?.(init.body);
            } catch {
              /* Capture is fail-open. */
            }
          }
          sent = true;
          const response = await doFetch(url, { ...init, redirect: "manual", signal });
          responseStatus = response.status;
          responseHeaders = scrub(safeUpstreamHeaders(response.headers)) as Record<string, string>;
          try {
            opts?.onResponseMeta?.(new Headers(responseHeaders));
          } catch {
            /* Metadata observers are fail-open. */
          }
          if (!response.ok) {
            // asResponse() bypasses success parsing, but SDK HTTP errors otherwise
            // call response.text() before returning. Bound them INSIDE fetch first.
            try {
              const maxBytes = Math.min(admission.capacityBytes, UPSTREAM_ERROR_BODY_MAX_BYTES);
              const raw = await consumeResponseTextWithinBudget(
                response,
                maxBytes,
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
              const rejected =
                response.status >= 400 && response.status < 500 && response.status !== 408;
              boundaryError = new ArkMediaError(
                rejected ? "rejected" : "unknown",
                "upstream_error",
                `Ark upstream returned HTTP ${response.status}`,
                raw,
                responseStatus,
                responseHeaders,
              );
            } catch (failure) {
              boundaryError = mapFailure(failure);
            }
            // SDK may wrap this in APIConnectionError; the per-call boundary error
            // is retained without the SDK's raw cause / headers / logging payload.
            throw boundaryError;
          }
          return response;
        },
      });
      const requestOptions = { headers, signal, maxRetries: 0 };
      // Ark permits prompt omission for layer decomposition. SDK types require it,
      // but its generate implementation forwards the object unchanged (offline tested).
      const request =
        kind === "image"
          ? client.images.generate(
              input as unknown as OpenAI.Images.ImageGenerateParamsNonStreaming,
              requestOptions,
            )
          : kind === "create"
            ? client.post(path, { ...requestOptions, body: input })
            : client.get(path, requestOptions);
      const response = await request.asResponse();
      return await consumeResponseTextWithinBudget(
        response,
        admission.capacityBytes,
        (text) => {
          try {
            return RecordSchema.parse(JSON.parse(text));
          } catch {
            throw error("invalid_response", "Ark upstream returned an invalid JSON object");
          }
        },
        admission,
        signal,
      );
    } catch (failure) {
      if (opts?.signal?.aborted) throw new ArkMediaAbortError(outcome());
      if (timeout.signal.aborted) {
        throw new ArkMediaError(
          outcome(),
          "timeout",
          "Ark media request timed out",
          { error: { code: "upstream_timeout" } },
          responseStatus,
          responseHeaders,
        );
      }
      throw boundaryError ?? mapFailure(failure);
    } finally {
      clearTimeout(timer);
    }

    function mapFailure(failure: unknown): ArkMediaError {
      if (failure instanceof ArkMediaError) return failure;
      if (failure instanceof ResponseBodyTooLargeError) {
        return error("response_body_too_large", failure.message, {
          error: { code: "response_body_too_large", limit_bytes: failure.limitBytes },
        });
      }
      if (failure instanceof ResponseWorkCapacityError) {
        return error("response_work_capacity_exhausted", failure.message, {
          error: { code: "response_work_capacity_exhausted", limit_bytes: failure.capacityBytes },
        });
      }
      // Never expose raw SDK errors: their cause/message can include auth or payloads.
      return error("transport_failure", "Ark media transport failed");
    }
  }

  return {
    imageGeneration: (body: Record<string, unknown>, opts?: ProviderCallOptions) =>
      call("image", body, opts),
    videoGeneration: (body: Record<string, unknown>, opts?: ProviderCallOptions) =>
      call("create", body, opts),
    videoRetrieve: (id: string, opts?: ProviderCallOptions) => call("retrieve", id, opts),
    threeDGeneration: (body: Record<string, unknown>, opts?: ProviderCallOptions) =>
      call("create", body, opts),
    threeDRetrieve: (id: string, opts?: ProviderCallOptions) => call("retrieve", id, opts),
  };
}
