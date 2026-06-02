import { SocksClient } from "socks";
import { Agent, buildConnector, type Dispatcher, ProxyAgent, fetch as undiciFetch } from "undici";

// Per-account egress proxy (issue #38 follow-up). Multiple subscription accounts
// of the SAME provider must not all egress from one IP — a shared address invites
// rate-limit/ban correlation. Each connected account may pin a proxy so its
// upstream traffic leaves through a distinct hop.
//
// Framework-agnostic (CLAUDE.md principle 1): this returns a drop-in `fetch` that
// the executor accepts via its injected `fetch` seam (openai/anthropic clients),
// so the proxy is invisible to the protocol layer. Built on undici: http/https go
// through the native `ProxyAgent`; socks5 goes through a custom-connector `Agent`
// whose socket is opened by the `socks` client (undici has no native SOCKS).
//
// SECURITY (principle 7): proxy credentials are embedded in the dispatcher only —
// NEVER logged. Callers must not stringify a ProxyConfig into telemetry.

export interface ProxyConfig {
  type: "http" | "https" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const PROXY_TYPES = new Set<ProxyConfig["type"]>(["http", "https", "socks5"]);

// Fail-closed validation (principle 2): a malformed proxy must surface as a clear
// throw at build time, not a confusing connect failure later. Never echoes
// credentials in the message.
export function validateProxyConfig(proxy: ProxyConfig): void {
  if (!PROXY_TYPES.has(proxy.type)) {
    throw new Error(`invalid proxy type: ${String(proxy.type)} (expected http | https | socks5)`);
  }
  if (typeof proxy.host !== "string" || proxy.host.trim() === "") {
    throw new Error("proxy host is required");
  }
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65_535) {
    throw new Error(`proxy port out of range: ${String(proxy.port)} (expected 1–65535)`);
  }
}

// Build the undici dispatcher for an HTTP/HTTPS forward proxy. Credentials (when
// present) ride in the `token` as a Basic auth header — undici sends it as the
// Proxy-Authorization header on CONNECT.
function httpProxyDispatcher(proxy: ProxyConfig): ProxyAgent {
  const uri = `${proxy.type}://${proxy.host}:${proxy.port}`;
  const token =
    proxy.username !== undefined
      ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}`
      : undefined;
  return new ProxyAgent(token ? { uri, token } : { uri });
}

// Build the undici dispatcher for a SOCKS5 proxy. undici has no native SOCKS, so we
// supply a custom `connect`: the `socks` client opens the raw TCP socket THROUGH
// the proxy to the destination, then undici's default connector takes over that
// socket as `httpSocket` to perform the (optional) TLS upgrade — so https targets
// still get a proper TLS handshake end-to-end past the proxy.
function socksProxyDispatcher(proxy: ProxyConfig): Agent {
  const base = buildConnector({});
  return new Agent({
    connect(options, callback) {
      // `options.hostname`/`options.port` are the DESTINATION (the upstream API),
      // not the proxy — SocksClient tunnels to it through the proxy server.
      const destPort =
        typeof options.port === "number"
          ? options.port
          : Number(options.port) || (options.protocol === "https:" ? 443 : 80);
      SocksClient.createConnection(
        {
          proxy: {
            host: proxy.host,
            port: proxy.port,
            type: 5,
            ...(proxy.username !== undefined
              ? { userId: proxy.username, password: proxy.password ?? "" }
              : {}),
          },
          command: "connect",
          destination: { host: options.hostname, port: destPort },
        },
        (err, info) => {
          if (err || !info) {
            callback(err ?? new Error("socks proxy connection failed"), null);
            return;
          }
          // Hand the established socket to undici's default connector for the TLS
          // upgrade (https) or pass-through (http).
          base({ ...options, httpSocket: info.socket }, callback);
        },
      );
    },
  });
}

// Build the undici dispatcher for a proxy (exported via the makeProxyFetch seam for
// unit tests that assert the dispatcher kind per type).
function dispatcherFor(proxy: ProxyConfig): Dispatcher {
  validateProxyConfig(proxy);
  return proxy.type === "socks5" ? socksProxyDispatcher(proxy) : httpProxyDispatcher(proxy);
}

// A `fetch` that routes every request through `proxy`. Drop-in for the executor's
// injected `fetch` seam. The dispatcher is built ONCE per call (the executor keeps
// one client per account, so this is one dispatcher per account — pooled).
export function makeProxyFetch(proxy: ProxyConfig): typeof globalThis.fetch {
  const dispatcher = dispatcherFor(proxy);
  // undici.fetch is spec-compatible with globalThis.fetch for our usage (string/URL
  // + RequestInit, returns a Response). The cast bridges undici's slightly distinct
  // Request/Response nominal types to the global ones.
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>) as typeof globalThis.fetch;
}

// Test-only seam: expose the dispatcher builder so a unit test can assert the
// dispatcher CLASS per proxy type without opening a socket. Not part of the public
// runtime contract.
makeProxyFetch._dispatcherFor = dispatcherFor;
