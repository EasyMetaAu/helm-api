import { createRequire } from "node:module";
import type { ProxyConfig } from "./proxy.js";
import { validateProxyConfig } from "./proxy.js";

type WreqTransport = {
  close: () => Promise<void> | void;
};

type CreateWreqTransport = (options: Record<string, unknown>) => Promise<WreqTransport>;
type WreqFetch = (url: string, options?: Record<string, unknown>) => Promise<Response>;
type WreqModule = {
  createTransport: CreateWreqTransport;
  fetch: WreqFetch;
};
type FetchHeadersInit =
  | Headers
  | Array<readonly [string, string] | readonly string[]>
  | Record<string, string | readonly string[] | number | boolean>;

const require = createRequire(import.meta.url);

export type TransportProfile = "auto" | "default" | "tls_chrome";

export class TlsTransportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsTransportUnavailableError";
  }
}

let wreqModuleOverride: WreqModule | null | undefined;

export function __setWreqModuleForTesting(mod: WreqModule | null | undefined): void {
  wreqModuleOverride = mod;
}

async function loadWreqModule(): Promise<WreqModule | null> {
  if (wreqModuleOverride !== undefined) return wreqModuleOverride;
  try {
    const mod = require("wreq-js") as {
      createTransport?: CreateWreqTransport;
      fetch?: WreqFetch;
    };
    return typeof mod.createTransport === "function" && typeof mod.fetch === "function"
      ? { createTransport: mod.createTransport, fetch: mod.fetch }
      : null;
  } catch {
    return null;
  }
}

function proxyHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

export function proxyConfigToUrl(proxy: ProxyConfig): string {
  validateProxyConfig(proxy);
  const auth =
    proxy.username !== undefined
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? "")}@`
      : "";
  return `${proxy.type}://${auth}${proxyHost(proxy.host)}:${proxy.port}`;
}

function normalizeHeaders(
  headers: FetchHeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value ?? "")]));
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function bodyRequestsStreaming(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed = JSON.parse(body) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

function wreqTransientCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name !== "RequestError" || typeof e.message !== "string") return null;
  const message = e.message.toLowerCase();
  if (message.includes("connection reset by peer")) return "ECONNRESET";
  if (message.includes("connection refused")) return "ECONNREFUSED";
  return null;
}

function normalizeWreqConnectionError(err: unknown): unknown {
  const code = wreqTransientCode(err);
  if (!code) return err;
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown };
    e.code = code;
    return err;
  }
  return err;
}

export interface TlsImpersonationFetchOptions {
  proxy?: ProxyConfig;
  browser?: string;
  os?: string;
  timeoutMs?: number;
}

export function makeTlsImpersonationFetch(
  options: TlsImpersonationFetchOptions = {},
): typeof globalThis.fetch {
  let transportPromise: Promise<WreqTransport> | null = null;
  let wreqFetch: WreqFetch | null = null;
  const transportOptions: Record<string, unknown> = {
    browser: options.browser ?? "chrome_142",
    os: options.os ?? "macos",
  };
  if (options.proxy) transportOptions.proxy = proxyConfigToUrl(options.proxy);

  async function transport(): Promise<WreqTransport> {
    if (transportPromise) return transportPromise;
    transportPromise = (async () => {
      const mod = await loadWreqModule();
      if (!mod) {
        throw new TlsTransportUnavailableError(
          "TLS impersonation transport requested but wreq-js is unavailable",
        );
      }
      wreqFetch = mod.fetch;
      return await mod.createTransport(transportOptions);
    })().catch((err) => {
      transportPromise = null;
      wreqFetch = null;
      throw err;
    });
    return transportPromise;
  }

  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const t = await transport();
    const fetch = wreqFetch;
    if (!fetch) {
      throw new TlsTransportUnavailableError(
        "TLS impersonation transport requested but wreq-js is unavailable",
      );
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = normalizeHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = init?.body ?? (input instanceof Request ? input.body : undefined);
    const timeout = bodyRequestsStreaming(body) ? 0 : (options.timeoutMs ?? 0);
    try {
      return await fetch(url, {
        method,
        headers,
        transport: t,
        cookieMode: "ephemeral",
        disableDefaultHeaders: true,
        timeout,
        ...(body !== undefined && body !== null ? { body } : {}),
        ...(init?.redirect ? { redirect: init.redirect } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
      });
    } catch (err) {
      throw normalizeWreqConnectionError(err);
    }
  }) as typeof globalThis.fetch;
}

export interface TlsTransportProbeResult {
  /** True when wreq-js loaded AND a throwaway transport could be created + closed. */
  ok: boolean;
  /** Human-readable reason when `ok` is false (module missing, native load failure, …). */
  error?: string;
}

/**
 * Startup probe for the optional Chrome-TLS transport. Loads wreq-js and creates
 * (then closes) a throwaway transport so a missing/incompatible native binary
 * surfaces at BOOT — not silently on the first Anthropic OAuth request, where the
 * thrown {@link TlsTransportUnavailableError} would count as a provider failure,
 * trip the circuit breaker, and degrade the request to the lane fallback chain.
 * The impersonated `browser`/`os` do not select the native binary (that is picked
 * from the runtime platform), so any value exercises the same load path.
 */
export async function checkTlsTransportAvailable(
  options: Pick<TlsImpersonationFetchOptions, "browser" | "os"> = {},
): Promise<TlsTransportProbeResult> {
  const mod = await loadWreqModule();
  if (!mod) {
    return { ok: false, error: "wreq-js native transport is not loadable on this platform" };
  }
  try {
    const transport = await mod.createTransport({
      browser: options.browser ?? "chrome_142",
      os: options.os ?? "macos",
    });
    await transport.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
