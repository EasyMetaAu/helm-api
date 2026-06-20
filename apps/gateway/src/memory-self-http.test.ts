import { describe, expect, it, vi } from "vitest";
import { createSelfHttpClient } from "./memory-self-http.js";

function fakeResponse(ok: boolean, body: unknown, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("createSelfHttpClient", () => {
  it("POSTs to /v1/chat/completions on loopback with the internal key + x-memory-mode:off, body verbatim", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(true, { choices: [{ message: { content: '{"facts":[]}' } }] }),
    );
    const client = createSelfHttpClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "helm_live_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      response_format: { type: "json_object" },
    };

    const res = await client.chatCompletion(req);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer helm_live_secret");
    expect(headers["x-memory-mode"]).toBe("off");
    // body is the request VERBATIM (model/messages/response_format preserved)
    expect(JSON.parse(init.body as string)).toEqual(req);
    // 2xx response is returned unchanged for callJsonModel to parse
    expect(res).toEqual({ choices: [{ message: { content: '{"facts":[]}' } }] });
  });

  it("prefixes a BARE model with providerPrefix (eval), leaves a prefixed model unchanged", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(true, {}));
    const client = createSelfHttpClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "k",
      providerPrefix: "deepseek",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // bare eval model → prefixed routable alias
    await client.chatCompletion({ model: "deepseek-v4-flash", messages: [] });
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string).model).toBe(
      "deepseek/deepseek-v4-flash",
    );
    // already-prefixed memory model → untouched
    await client.chatCompletion({ model: "openrouter/deepseek-v4-pro", messages: [] });
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string).model).toBe(
      "openrouter/deepseek-v4-pro",
    );
  });

  it("does NOT prefix a bare LANE name — forwards it verbatim so /v1 routes it as an explicit lane", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(true, {}));
    const client = createSelfHttpClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "k",
      providerPrefix: "deepseek",
      // A configured value that is a known LANE must reach the router as the lane name,
      // NOT be mangled into "deepseek/<lane>" (which the primary provider would reject).
      isLane: (m) => m === "economy" || m === "balanced",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // bare LANE → verbatim (gateway lane-as-model routing expands its chain)
    await client.chatCompletion({ model: "economy", messages: [] });
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string).model).toBe(
      "economy",
    );
    // bare NON-lane model → still prefixed to a routable explicit alias
    await client.chatCompletion({ model: "deepseek-v4-flash", messages: [] });
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string).model).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("throws on non-2xx so the caller's fail-open fallback fires", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(false, { error: "boom" }, 500),
    );
    const client = createSelfHttpClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.chatCompletion({ model: "m", messages: [] })).rejects.toThrow(
      /self-http 500/,
    );
  });

  it("forwards the abort signal", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(true, {}));
    const client = createSelfHttpClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ctrl = new AbortController();
    await client.chatCompletion({ model: "m", messages: [] }, { signal: ctrl.signal });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(ctrl.signal);
  });
});
