import type { ProviderClient } from "@helm/core";

// Internal self-HTTP client (observability). Internal LLM tasks (memory
// summarize/merge/extractFacts, Layer-2 eval) normally call a ProviderClient DIRECTLY,
// which bypasses the gateway's telemetry + request/response payload capture — so they
// never appear in /admin/requests and the operator cannot see what was sent to the
// upstream model. This client is a drop-in ProviderClient that instead routes the call
// BACK THROUGH helm's own POST /v1/chat/completions over loopback, so it is recorded
// like any real request. It is authenticated with an internal API key and always sends
// `x-memory-mode: off` so the self-call is NEVER itself observed (no memory-on-memory
// loop). Only `chatCompletion` is exercised (these tasks are non-streaming); the stream
// method is a required-by-interface stub.

export interface SelfHttpClientDeps {
  // Loopback base URL, e.g. http://127.0.0.1:8080 (NOT config.server.host, which may be
  // 0.0.0.0 and is not a connectable address).
  baseUrl: string;
  // Internal API key plaintext (e.g. the auto-minted internal key). Sent as a bearer.
  apiKey: string;
  // Optional provider prefix for BARE model ids (no "/"). The /v1 explicit-model
  // passthrough needs a routable alias; a bare model (e.g. the Layer-2 eval model
  // "deepseek-v4-flash", which today goes straight to providers[0]) is rewritten to
  // `${providerPrefix}/${model}` so it routes the same way. A model that already carries
  // a "provider/" prefix (e.g. memory's "deepseek/deepseek-v4-flash") is left unchanged.
  providerPrefix?: string;
  // Injectable fetch for tests; defaults to the global fetch.
  fetchImpl?: typeof globalThis.fetch;
}

export function createSelfHttpClient(deps: SelfHttpClientDeps): ProviderClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  return {
    async chatCompletion(req, opts) {
      const rawModel = typeof req.model === "string" ? req.model : "";
      const model =
        deps.providerPrefix && rawModel.length > 0 && !rawModel.includes("/")
          ? `${deps.providerPrefix}/${rawModel}`
          : rawModel;
      const body = model === rawModel ? req : { ...req, model };
      const res = await fetchImpl(`${deps.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.apiKey}`,
          // The self-call IS the memory machinery — it must never be observed or have
          // memory injected, else it would recursively form/inject memory about itself.
          "x-memory-mode": "off",
        },
        body: JSON.stringify(body),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) {
        // Non-2xx → throw so the caller's existing fail-open catch (callJsonModel for
        // memory, the eval invoker for classify) degrades to its deterministic fallback
        // exactly as a direct provider error would.
        const body = await res.text().catch(() => "");
        throw new Error(`self-http ${res.status}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as Record<string, unknown>;
    },
    // Required by the ProviderClient interface; internal LLM tasks are non-streaming.
    async *chatCompletionStream() {
      // never called for memory/eval
    },
  };
}
