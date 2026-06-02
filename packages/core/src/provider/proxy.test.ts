import { Agent, ProxyAgent } from "undici";
import { describe, expect, it } from "vitest";
import { makeProxyFetch, type ProxyConfig, validateProxyConfig } from "./proxy.js";

// Per-account egress proxy (issue #38 follow-up). Unit-only: NO real network — a
// proxy fetch is asserted by the SHAPE it produces (it returns a fetch function;
// http/https route through an undici ProxyAgent, socks5 through a custom-connector
// Agent). The actual tunnel is exercised by integration, not here.

const HTTP: ProxyConfig = { type: "http", host: "127.0.0.1", port: 8080 };
const HTTPS: ProxyConfig = { type: "https", host: "127.0.0.1", port: 8443 };
const SOCKS: ProxyConfig = { type: "socks5", host: "127.0.0.1", port: 1080 };

describe("validateProxyConfig", () => {
  it("accepts a well-formed http proxy", () => {
    expect(() => validateProxyConfig(HTTP)).not.toThrow();
  });

  it("accepts socks5 with credentials", () => {
    expect(() => validateProxyConfig({ ...SOCKS, username: "u", password: "p" })).not.toThrow();
  });

  it("rejects an unknown proxy type", () => {
    expect(() => validateProxyConfig({ type: "ftp" as never, host: "h", port: 1 })).toThrow(
      /proxy type/,
    );
  });

  it("rejects an empty host", () => {
    expect(() => validateProxyConfig({ ...HTTP, host: "" })).toThrow(/host/);
  });

  it("rejects a port out of range", () => {
    expect(() => validateProxyConfig({ ...HTTP, port: 0 })).toThrow(/port/);
    expect(() => validateProxyConfig({ ...HTTP, port: 70_000 })).toThrow(/port/);
  });
});

describe("makeProxyFetch", () => {
  it("returns a fetch function for http", () => {
    expect(typeof makeProxyFetch(HTTP)).toBe("function");
  });

  it("returns a fetch function for https", () => {
    expect(typeof makeProxyFetch(HTTPS)).toBe("function");
  });

  it("returns a fetch function for socks5", () => {
    expect(typeof makeProxyFetch(SOCKS)).toBe("function");
  });

  // The dispatcher kind is the load-bearing detail: http/https must use undici's
  // ProxyAgent; socks5 must use a custom-connector Agent (NOT a ProxyAgent, which
  // cannot speak the SOCKS handshake). We assert the dispatcher class per type via
  // the test seam `_dispatcherFor`.
  it("builds a ProxyAgent dispatcher for http/https", () => {
    expect(makeProxyFetch._dispatcherFor(HTTP)).toBeInstanceOf(ProxyAgent);
    expect(makeProxyFetch._dispatcherFor(HTTPS)).toBeInstanceOf(ProxyAgent);
  });

  it("builds a custom-connector Agent (not ProxyAgent) for socks5", () => {
    const d = makeProxyFetch._dispatcherFor(SOCKS);
    expect(d).toBeInstanceOf(Agent);
    expect(d).not.toBeInstanceOf(ProxyAgent);
  });

  it("validates the config (throws on a bad proxy)", () => {
    expect(() => makeProxyFetch({ type: "http", host: "", port: 1 })).toThrow(/host/);
  });
});
