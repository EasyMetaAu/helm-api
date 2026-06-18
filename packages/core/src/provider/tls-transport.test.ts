import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "./proxy.js";
import {
  __setWreqCreateSessionForTesting,
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
  __setWreqCreateSessionForTesting(undefined);
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
  it("creates a lazy wreq session and forwards fetch options", async () => {
    const sessionOptions: unknown[] = [];
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    __setWreqCreateSessionForTesting(async (options) => {
      sessionOptions.push(options);
      return { fetch: fetchSpy, close: vi.fn() };
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
    expect(sessionOptions).toEqual([
      {
        browser: "chrome_142",
        os: "linux",
        proxy: "http://user:p%40ss@127.0.0.1:8080",
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-test": "yes" },
      body: "{}",
      timeout: 1234,
    });
  });

  it("throws a named unavailable error when the optional native package is absent", async () => {
    __setWreqCreateSessionForTesting(null);
    const tlsFetch = makeTlsImpersonationFetch();

    await expect(tlsFetch("https://api.anthropic.com/v1/messages")).rejects.toBeInstanceOf(
      TlsTransportUnavailableError,
    );
  });
});
