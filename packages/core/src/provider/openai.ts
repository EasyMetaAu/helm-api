// OpenAI-compatible upstream client. Phase 0 = PASSTHROUGH ONLY: no protocol
// translation, no classification, no lanes, no fallback, no circuit breaker
// (all Phase 1/2). Framework-agnostic (no Hono). Credentials come only from the
// injected config (env-sourced) and are never logged or echoed. See docs/02.

// Provider credential: EXACTLY ONE of a static `apiKey` or a dynamic
// `getAuthHeader` (issue #38 OAuth). The dynamic path also accepts:
//   - `onUnauthorized`: invoked once on an upstream 401 to force a token refresh
//     (the manager's invalidate), after which the request is retried exactly once
//     with the freshly fetched header (D2 — the retry lives here in the client,
//     not the executor, so the SAME request is replayed with the new token).
//   - `currentSecrets`: live access + refresh tokens, used by `scrub()` to strip
//     any echoed credential from an upstream error body (principle 7).
// Credentials are runtime-only: from env, never persisted/logged.
export interface ProviderConfig {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  apiKey?: string; // static credential; mutually exclusive with getAuthHeader
  getAuthHeader?: () => Promise<string>; // dynamic "Bearer <token>" (OAuth)
  onUnauthorized?: () => void; // 401 hook (force refresh); only with getAuthHeader
  currentSecrets?: () => string[]; // live token set for redaction (OAuth)
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
  // Real upstream HTTP status (e.g. 429), preserved separately from the
  // client-facing `httpStatus` (which stays 502/504 for back-compat). null when
  // there is no upstream response status (timeout/network error). The executor
  // reads this for the `:free` 429-skip rule (docs/04, principle 5).
  readonly upstreamStatus: number | null;
  readonly providerRaw: unknown | null;
  constructor(
    errorClass: "upstream_error" | "timeout",
    message: string,
    providerRaw: unknown | null = null,
    upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = "UpstreamError";
    this.errorClass = errorClass;
    this.httpStatus = errorClass === "timeout" ? 504 : 502;
    this.upstreamStatus = upstreamStatus;
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
  const cfg = deps.config;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${cfg.baseUrl}/chat/completions`;

  // Fail-closed credential guard (principle 2): EXACTLY ONE of static apiKey or
  // dynamic getAuthHeader. A client built with both / neither cannot resolve an
  // unambiguous auth header, so refuse construction rather than silently pick one.
  const hasStatic = cfg.apiKey !== undefined;
  const hasDynamic = cfg.getAuthHeader !== undefined;
  if (hasStatic === hasDynamic) {
    throw new Error("provider client requires exactly one of `apiKey` or `getAuthHeader`");
  }

  // Per-request auth header. Static path returns the constant key; dynamic path
  // awaits the (possibly refreshed) OAuth token so two requests separated by a
  // refresh carry different Bearers (acceptance criterion 3).
  async function authHeader(): Promise<string> {
    if (cfg.getAuthHeader !== undefined) return await cfg.getAuthHeader();
    return `Bearer ${cfg.apiKey}`;
  }

  async function headers(): Promise<Record<string, string>> {
    return {
      Authorization: await authHeader(),
      "Content-Type": "application/json",
    };
  }

  // Strip any echoed credential from an upstream error body before it is carried
  // in UpstreamError.providerRaw (defense in depth; redact() is the main gate).
  // Static path scrubs the apiKey; OAuth path scrubs every LIVE token (access +
  // refresh). Empty / very-short secrets are skipped so an empty token never
  // replaces the whole body and a 1-char token never over-redacts.
  function scrub(raw: unknown): unknown {
    if (raw === null || typeof raw !== "object") return raw;
    const secrets = cfg.currentSecrets ? cfg.currentSecrets() : [];
    if (cfg.apiKey !== undefined) secrets.push(cfg.apiKey);
    let json = JSON.stringify(raw);
    let changed = false;
    for (const secret of secrets) {
      // Skip empty/too-short secrets: an empty string would blow the body away,
      // and a single character would redact unrelated content.
      if (secret.length < 4) continue;
      if (json.includes(secret)) {
        json = json.split(secret).join("[redacted]");
        changed = true;
      }
    }
    return changed ? JSON.parse(json) : raw;
  }

  async function request(
    req: ChatCompletionRequest,
    external: AbortSignal | undefined,
  ): Promise<Response> {
    const t = withTimeout(timeoutMs, external);
    try {
      return await doFetch(url, {
        method: "POST",
        headers: await headers(),
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

  // Issue the request, applying the OAuth 401 single-retry (D2): on a 401 with an
  // onUnauthorized hook, force a token refresh and replay the SAME request exactly
  // once with the new header. `allowRetry` is false on the replay so a persistent
  // 401 falls through to the normal error path (one retry, never a loop). Returns
  // the Response with res.ok already true OR a non-401 / exhausted-retry error res.
  async function requestWithAuthRetry(
    req: ChatCompletionRequest,
    external: AbortSignal | undefined,
  ): Promise<Response> {
    const res = await request(req, external);
    if (res.status === 401 && cfg.onUnauthorized !== undefined) {
      // Discard the 401 body (it may echo the credential) before refreshing.
      await res.body?.cancel().catch(() => {});
      cfg.onUnauthorized();
      return await request(req, external); // exactly one retry with the new token
    }
    return res;
  }

  async function errorFromResponse(res: Response): Promise<UpstreamError> {
    const providerRaw = await res
      .json()
      .catch(() => null)
      .then(scrub);
    return new UpstreamError(
      "upstream_error",
      `upstream returned ${res.status}`,
      providerRaw,
      res.status,
    );
  }

  return {
    async chatCompletion(req, opts) {
      const res = await requestWithAuthRetry(req, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as ChatCompletionResponse;
    },

    async *chatCompletionStream(req, opts) {
      // 401-retry happens here, BEFORE getReader() / any chunk is yielded, so the
      // SSE stream is replayed cleanly from the start (principle 8 — no duplicated
      // or half-emitted events).
      const res = await requestWithAuthRetry(req, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
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
