// OpenAI-compatible upstream client. Phase 0 = PASSTHROUGH ONLY: no protocol
// translation, no classification, no lanes, no fallback, no circuit breaker
// (all Phase 1/2). Framework-agnostic (no Hono). Credentials come only from the
// injected config (env-sourced) and are never logged or echoed. See docs/02.

export interface ProviderConfig {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  apiKey: string; // runtime-only; from env; never persisted/logged
  timeoutMs?: number; // default 60_000
}

export interface OpenAIClientDeps {
  config: ProviderConfig;
  fetch?: typeof globalThis.fetch;
}

export type ChatCompletionRequest = Record<string, unknown>;
export type ChatCompletionResponse = Record<string, unknown>;

export interface ProviderClient {
  chatCompletion(
    req: ChatCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<ChatCompletionResponse>;
  chatCompletionStream(
    req: ChatCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string>;
}

// Upstream non-2xx / network error / timeout. The gateway maps this to an
// OpenAI-shaped error. providerRaw is redacted before logging by the caller.
export class UpstreamError extends Error {
  readonly errorClass: "upstream_error" | "timeout";
  readonly httpStatus: number;
  readonly providerRaw: unknown | null;
  constructor(
    errorClass: "upstream_error" | "timeout",
    message: string,
    providerRaw: unknown | null = null,
  ) {
    super(message);
    this.name = "UpstreamError";
    this.errorClass = errorClass;
    this.httpStatus = errorClass === "timeout" ? 504 : 502;
    this.providerRaw = providerRaw;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

// Merge the caller's signal (client disconnect) with a timeout signal. Returns
// the combined signal plus a marker so the caller can distinguish a timeout
// abort (-> UpstreamError(timeout)) from a client abort (-> rethrow AbortError).
function withTimeout(timeoutMs: number, external?: AbortSignal) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals = [timeoutController.signal];
  if (external) signals.push(external);
  // AbortSignal.any is available in Node 20+/22+.
  const signal = AbortSignal.any(signals);
  return {
    signal,
    isTimeout: () => timeoutController.signal.aborted,
    isExternalAbort: () => external?.aborted ?? false,
    cleanup: () => clearTimeout(timer),
  };
}

export function createOpenAIClient(deps: OpenAIClientDeps): ProviderClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${deps.config.baseUrl}/chat/completions`;

  function headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${deps.config.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  // Strip any echoed credential from an upstream error body before it is carried
  // in UpstreamError.providerRaw (defense in depth; redact() is the main gate).
  function scrub(raw: unknown): unknown {
    if (raw === null || typeof raw !== "object") return raw;
    const key = deps.config.apiKey;
    const json = JSON.stringify(raw);
    if (key.length > 0 && json.includes(key)) {
      return JSON.parse(json.split(key).join("[redacted]"));
    }
    return raw;
  }

  async function request(
    req: ChatCompletionRequest,
    external: AbortSignal | undefined,
  ): Promise<Response> {
    const t = withTimeout(timeoutMs, external);
    try {
      return await doFetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(req),
        signal: t.signal,
      });
    } catch (err) {
      if (t.isTimeout() && !t.isExternalAbort()) {
        throw new UpstreamError("timeout", "upstream request timed out");
      }
      // Client abort is NOT a provider fault — rethrow as-is for the caller.
      throw err;
    } finally {
      t.cleanup();
    }
  }

  return {
    async chatCompletion(req, opts) {
      const res = await request(req, opts?.signal);
      if (!res.ok) {
        const providerRaw = await res
          .json()
          .catch(() => null)
          .then(scrub);
        throw new UpstreamError("upstream_error", `upstream returned ${res.status}`, providerRaw);
      }
      return (await res.json()) as ChatCompletionResponse;
    },

    async *chatCompletionStream(req, opts) {
      const res = await request(req, opts?.signal);
      if (!res.ok) {
        const providerRaw = await res
          .json()
          .catch(() => null)
          .then(scrub);
        throw new UpstreamError("upstream_error", `upstream returned ${res.status}`, providerRaw);
      }
      const body = res.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
