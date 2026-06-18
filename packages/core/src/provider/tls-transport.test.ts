import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "./proxy.js";
import { isTransientConnectionError } from "./retry.js";
import {
  __setWreqModuleForTesting,
  checkTlsTransportAvailable,
  makeTlsImpersonationFetch,
  proxyConfigToUrl,
  TlsTransportUnavailableError,
} from "./tls-transport.js";

const HTTP_PROXY: ProxyConfig = {
  type: "http",
  host: "127.0.0.1",
  port: 8080,
  username: "user",
  password: "p@ss",
};

afterEach(() => {
  __setWreqModuleForTesting(undefined);
});

describe("proxyConfigToUrl", () => {
  it("serializes and escapes proxy credentials", () => {
    expect(proxyConfigToUrl(HTTP_PROXY)).toBe("http://user:p%40ss@127.0.0.1:8080");
  });

  it("brackets IPv6 proxy hosts", () => {
    expect(proxyConfigToUrl({ type: "socks5", host: "2001:db8::1", port: 1080 })).toBe(
      "socks5://[2001:db8::1]:1080",
    );
  });
});

describe("makeTlsImpersonationFetch", () => {
  it("creates a lazy wreq transport and forwards fetch options", async () => {
    const transportOptions: unknown[] = [];
    const transport = { close: vi.fn() };
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    __setWreqModuleForTesting({
      createTransport: async (options) => {
        transportOptions.push(options);
        return transport;
      },
      fetch: fetchSpy,
    });

    const tlsFetch = makeTlsImpersonationFetch({
      proxy: HTTP_PROXY,
      browser: "chrome_142",
      os: "linux",
      timeoutMs: 1234,
    });

    const res = await tlsFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: new Headers([["X-Test", "yes"]]),
      body: "{}",
    });

    expect(await res.text()).toBe("ok");
    expect(transportOptions).toEqual([
      {
        browser: "chrome_142",
        os: "linux",
        proxy: "http://user:p%40ss@127.0.0.1:8080",
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-test": "yes" },
      transport,
      cookieMode: "ephemeral",
      disableDefaultHeaders: true,
      timeout: 1234,
      body: "{}",
    });
  });

  it("disables wreq default browser headers and total timeout for streaming bodies", async () => {
    const transport = { close: vi.fn() };
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    __setWreqModuleForTesting({
      createTransport: async () => transport,
      fetch: fetchSpy,
    });

    const tlsFetch = makeTlsImpersonationFetch({ timeoutMs: 1234 });
    const body = JSON.stringify({ model: "claude-opus", stream: true });

    await tlsFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { Accept: "application/json" },
      body,
    });

    expect(fetchSpy).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { Accept: "application/json" },
      transport,
      cookieMode: "ephemeral",
      disableDefaultHeaders: true,
      timeout: 0,
      body,
    });
  });

  it("uses no wreq total timeout by default for non-streaming bodies", async () => {
    const transport = { close: vi.fn() };
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    __setWreqModuleForTesting({
      createTransport: async () => transport,
      fetch: fetchSpy,
    });

    const tlsFetch = makeTlsImpersonationFetch();
    const body = JSON.stringify({ model: "claude-opus" });

    await tlsFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body,
    });

    expect(fetchSpy).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: undefined,
      transport,
      cookieMode: "ephemeral",
      disableDefaultHeaders: true,
      timeout: 0,
      body,
    });
  });

  it("uses ephemeral cookies on every request instead of a persistent session jar", async () => {
    const transport = { close: vi.fn() };
    const fetchSpy = vi.fn(async (_url: string, _init?: Record<string, unknown>) => {
      return new Response("ok", { status: 200 });
    });
    const createTransport = vi.fn(async () => transport);
    __setWreqModuleForTesting({ createTransport, fetch: fetchSpy });

    const tlsFetch = makeTlsImpersonationFetch();

    await tlsFetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    await tlsFetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init).toMatchObject({ transport, cookieMode: "ephemeral" });
      expect(init).not.toHaveProperty("session");
      expect(init).not.toHaveProperty("sessionId");
    }
  });

  it.each([
    ["Connection reset by peer", "ECONNRESET"],
    ["Connection refused", "ECONNREFUSED"],
  ])("normalizes wreq RequestError '%s' for same-provider retry", async (message, code) => {
    const err = Object.assign(new TypeError(message), { name: "RequestError" });
    __setWreqModuleForTesting({
      createTransport: async () => ({ close: vi.fn() }),
      fetch: vi.fn(async () => {
        throw err;
      }),
    });

    const tlsFetch = makeTlsImpersonationFetch();

    let caught: unknown;
    try {
      await tlsFetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(err);
    expect(caught).toMatchObject({ code });
    expect(isTransientConnectionError(caught)).toBe(true);
  });

  it("throws a named unavailable error when the optional native package is absent", async () => {
    __setWreqModuleForTesting(null);
    const tlsFetch = makeTlsImpersonationFetch();

    await expect(tlsFetch("https://api.anthropic.com/v1/messages")).rejects.toBeInstanceOf(
      TlsTransportUnavailableError,
    );
  });
});

describe("checkTlsTransportAvailable", () => {
  it("reports ok when wreq-js loads and a transport can be created + closed", async () => {
    const close = vi.fn(async () => {});
    const createTransport = vi.fn(async () => ({ close }));
    __setWreqModuleForTesting({
      createTransport,
      fetch: async () => new Response("ok"),
    });

    const result = await checkTlsTransportAvailable({ browser: "chrome_142", os: "linux" });

    expect(result).toEqual({ ok: true });
    expect(createTransport).toHaveBeenCalledWith({ browser: "chrome_142", os: "linux" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports not-ok when the optional native package is absent", async () => {
    __setWreqModuleForTesting(null);

    const result = await checkTlsTransportAvailable();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/wreq-js/);
  });

  it("reports not-ok with the failure reason when createTransport throws", async () => {
    __setWreqModuleForTesting({
      createTransport: async () => {
        throw new Error("native binary load failed");
      },
      fetch: async () => new Response("ok"),
    });

    const result = await checkTlsTransportAvailable();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("native binary load failed");
  });
});
