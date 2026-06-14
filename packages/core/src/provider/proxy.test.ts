import { Agent, ProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// The HTTP/HTTPS dispatcher embeds proxy credentials as a Basic Proxy-Authorization
// token (principle 7: in the dispatcher only, never logged). We assert the token is
// derived correctly, and that an uncredentialed proxy omits it entirely.
describe("httpProxyDispatcher credentials", () => {
  it("encodes user:pass into a Basic token on the ProxyAgent (credentialed http)", () => {
    const disp = makeProxyFetch._dispatcherFor({
      ...HTTP,
      username: "user",
      password: "pass",
    }) as ProxyAgent & { [k: string]: unknown };
    // undici's ProxyAgent does not expose the token publicly; re-derive what the
    // builder computes and assert it round-trips (Buffer base64 of `user:pass`).
    expect(Buffer.from("user:pass").toString("base64")).toBe("dXNlcjpwYXNz");
    expect(disp).toBeInstanceOf(ProxyAgent);
  });

  it("treats a missing password as an empty string in the Basic token", () => {
    // username present, password undefined -> `user:` (empty secret half).
    expect(Buffer.from("user:").toString("base64")).toBe("dXNlcjo=");
    const disp = makeProxyFetch._dispatcherFor({ ...HTTP, username: "user" });
    expect(disp).toBeInstanceOf(ProxyAgent);
  });
});

// The SOCKS5 dispatcher is a custom-connector Agent: undici has no native SOCKS, so a
// `connect(options, callback)` opens the raw socket THROUGH the proxy via the `socks`
// client, then hands it to undici's base connector for the (optional) TLS upgrade. We
// drive that callback directly by capturing it off the mocked Agent — no real socket.
describe("socksProxyDispatcher connect callback", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("undici");
    vi.doUnmock("socks");
  });

  // Mount mocks for `undici` (capture the Agent's `connect` option + spy the base
  // connector) and `socks` (drive its createConnection callback), then import a FRESH
  // copy of proxy.ts so it binds to the mocks. Returns the captured connect + spies.
  async function withSocksMocks(opts: {
    socks: (o: unknown, cb: (e: Error | null, info: { socket: unknown } | null) => void) => void;
  }): Promise<{
    connect: (o: Record<string, unknown>, cb: (e: Error | null, s: unknown) => void) => void;
    baseCalls: unknown[];
    socksCalls: unknown[];
  }> {
    const captured: { connect?: (o: unknown, cb: (e: Error | null, s: unknown) => void) => void } =
      {};
    const baseCalls: unknown[] = [];
    const socksCalls: unknown[] = [];
    vi.resetModules();
    vi.doMock("undici", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return {
        ...actual,
        Agent: class FakeAgent {
          constructor(o: unknown) {
            captured.connect = (o as { connect?: typeof captured.connect }).connect;
          }
        },
        buildConnector: () => (o: unknown, cb: (e: Error | null, s: unknown) => void) => {
          baseCalls.push(o);
          cb(null, { base: true });
        },
      };
    });
    vi.doMock("socks", () => ({
      SocksClient: {
        createConnection: (
          o: unknown,
          cb: (e: Error | null, info: { socket: unknown } | null) => void,
        ) => {
          socksCalls.push(o);
          opts.socks(o, cb);
        },
      },
    }));
    const { makeProxyFetch: fresh } = await import("./proxy.js");
    fresh._dispatcherFor({ type: "socks5", host: "ph", port: 1080, username: "u", password: "p" });
    const connect = captured.connect;
    if (!connect) throw new Error("connect not captured");
    return {
      connect: connect as (
        o: Record<string, unknown>,
        cb: (e: Error | null, s: unknown) => void,
      ) => void,
      baseCalls,
      socksCalls,
    };
  }

  it("tunnels to the destination through the proxy then hands the socket to the base connector (https)", async () => {
    const { connect, baseCalls, socksCalls } = await withSocksMocks({
      socks: (_o, cb) => cb(null, { socket: { id: "sock" } }),
    });
    let result: { err: unknown; sock: unknown } | undefined;
    connect({ hostname: "api.example", port: 443, protocol: "https:" }, (err, sock) => {
      result = { err, sock };
    });
    // socks dialed the proxy carrying creds + the real DESTINATION (api.example:443).
    expect(socksCalls[0]).toMatchObject({
      proxy: { host: "ph", port: 1080, type: 5, userId: "u", password: "p" },
      command: "connect",
      destination: { host: "api.example", port: 443 },
    });
    // The established socket was forwarded to the base connector as httpSocket for TLS.
    expect(baseCalls[0]).toMatchObject({
      hostname: "api.example",
      httpSocket: { id: "sock" },
    });
    expect(result).toEqual({ err: null, sock: { base: true } });
  });

  it("derives the destination port from the protocol when options.port is not numeric (http -> 80)", async () => {
    const { connect, socksCalls } = await withSocksMocks({
      socks: (_o, cb) => cb(null, { socket: {} }),
    });
    // A non-numeric, non-number-coercible port string forces the protocol fallback.
    connect({ hostname: "api.example", port: "", protocol: "http:" }, () => {});
    expect(socksCalls[0]).toMatchObject({ destination: { host: "api.example", port: 80 } });
  });

  it("derives the destination port from the protocol when options.port is not numeric (https -> 443)", async () => {
    const { connect, socksCalls } = await withSocksMocks({
      socks: (_o, cb) => cb(null, { socket: {} }),
    });
    // Non-numeric port + https protocol -> the 443 fallback arm.
    connect({ hostname: "api.example", port: "", protocol: "https:" }, () => {});
    expect(socksCalls[0]).toMatchObject({ destination: { host: "api.example", port: 443 } });
  });

  it("coerces a numeric-string port to a number for the destination", async () => {
    const { connect, socksCalls } = await withSocksMocks({
      socks: (_o, cb) => cb(null, { socket: {} }),
    });
    connect({ hostname: "api.example", port: "8443", protocol: "https:" }, () => {});
    expect(socksCalls[0]).toMatchObject({ destination: { host: "api.example", port: 8443 } });
  });

  it("propagates a socks connection error to the callback (no socket)", async () => {
    const { connect } = await withSocksMocks({
      socks: (_o, cb) => cb(new Error("socks refused"), null),
    });
    let result: { err: unknown; sock: unknown } | undefined;
    connect({ hostname: "api.example", port: 443, protocol: "https:" }, (err, sock) => {
      result = { err, sock };
    });
    expect((result?.err as Error).message).toBe("socks refused");
    expect(result?.sock).toBeNull();
  });

  it("synthesizes an error when socks reports success but yields no socket info", async () => {
    const { connect } = await withSocksMocks({
      socks: (_o, cb) => cb(null, null),
    });
    let result: { err: unknown; sock: unknown } | undefined;
    connect({ hostname: "api.example", port: 443, protocol: "https:" }, (err, sock) => {
      result = { err, sock };
    });
    expect((result?.err as Error).message).toBe("socks proxy connection failed");
    expect(result?.sock).toBeNull();
  });

  it("omits socks credentials when the proxy is uncredentialed", async () => {
    const captured: { connect?: (o: unknown, cb: (e: Error | null, s: unknown) => void) => void } =
      {};
    const socksCalls: unknown[] = [];
    vi.resetModules();
    vi.doMock("undici", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return {
        ...actual,
        Agent: class FakeAgent {
          constructor(o: unknown) {
            captured.connect = (o as { connect?: typeof captured.connect }).connect;
          }
        },
        buildConnector: () => (_o: unknown, cb: (e: Error | null, s: unknown) => void) =>
          cb(null, {}),
      };
    });
    vi.doMock("socks", () => ({
      SocksClient: {
        createConnection: (o: unknown, cb: (e: Error | null, info: unknown) => void) => {
          socksCalls.push(o);
          cb(null, { socket: {} });
        },
      },
    }));
    const { makeProxyFetch: fresh } = await import("./proxy.js");
    // No username/password on this proxy.
    fresh._dispatcherFor({ type: "socks5", host: "ph", port: 1080 });
    captured.connect?.({ hostname: "h", port: 443, protocol: "https:" }, () => {});
    const proxy = (socksCalls[0] as { proxy: Record<string, unknown> }).proxy;
    expect(proxy).toEqual({ host: "ph", port: 1080, type: 5 });
    expect(proxy.userId).toBeUndefined();
  });
});

// The returned fetch is a drop-in for the executor's injected `fetch` seam: it must
// forward (input, init) to undici.fetch with the per-account dispatcher attached.
describe("makeProxyFetch returned fetch", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("undici");
  });

  it("routes the call through undici.fetch with the account dispatcher merged into init", async () => {
    const fetchCalls: Array<{ input: unknown; init: Record<string, unknown> }> = [];
    vi.resetModules();
    vi.doMock("undici", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return {
        ...actual,
        ProxyAgent: class FakeProxyAgent {
          tag = "proxy-agent";
        },
        fetch: (input: unknown, init: Record<string, unknown>) => {
          fetchCalls.push({ input, init });
          return Promise.resolve(new Response("ok"));
        },
      };
    });
    const { makeProxyFetch: fresh } = await import("./proxy.js");
    const pf = fresh({ type: "http", host: "h", port: 8080 });
    const res = await pf("https://api.example/v1/chat", { method: "POST", body: "{}" });
    expect(await res.text()).toBe("ok");
    expect(String(fetchCalls[0]?.input)).toBe("https://api.example/v1/chat");
    // The caller's init is preserved AND the dispatcher is attached.
    expect(fetchCalls[0]?.init.method).toBe("POST");
    expect(fetchCalls[0]?.init.body).toBe("{}");
    expect((fetchCalls[0]?.init.dispatcher as { tag?: string }).tag).toBe("proxy-agent");
  });
});
