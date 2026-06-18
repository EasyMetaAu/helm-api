import { createRequire } from "node:module";
import type { ProxyConfig } from "./proxy.js";
import { validateProxyConfig } from "./proxy.js";

type WreqSession = {
  fetch: (url: string, options?: Record<string, unknown>) => Promise<Response>;
  close: () => Promise<void> | void;
};

type CreateWreqSession = (options: Record<string, unknown>) => Promise<WreqSession>;
type FetchHeadersInit =
  | Headers
  | Array<readonly [string, string] | readonly string[]>
  | Record<string, string | readonly string[] | number | boolean>;

const require = createRequire(import.meta.url);

export type TransportProfile = "default" | "tls_chrome";

export class TlsTransportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsTransportUnavailableError";
  }
}

let createSessionOverride: CreateWreqSession | null | undefined;

export function __setWreqCreateSessionForTesting(fn: CreateWreqSession | null | undefined): void {
  createSessionOverride = fn;
}

async function loadCreateSession(): Promise<CreateWreqSession | null> {
  if (createSessionOverride !== undefined) return createSessionOverride;
  try {
    const mod = require("wreq-js") as { createSession?: CreateWreqSession };
    return typeof mod.createSession === "function" ? mod.createSession : null;
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

export interface TlsImpersonationFetchOptions {
  proxy?: ProxyConfig;
  browser?: string;
  os?: string;
  timeoutMs?: number;
}

export function makeTlsImpersonationFetch(
  options: TlsImpersonationFetchOptions = {},
): typeof globalThis.fetch {
  let sessionPromise: Promise<WreqSession> | null = null;
  const sessionOptions: Record<string, unknown> = {
    browser: options.browser ?? "chrome_142",
    os: options.os ?? "macos",
  };
  if (options.proxy) sessionOptions.proxy = proxyConfigToUrl(options.proxy);

  async function session(): Promise<WreqSession> {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      const createSession = await loadCreateSession();
      if (!createSession) {
        throw new TlsTransportUnavailableError(
          "TLS impersonation transport requested but wreq-js is unavailable",
        );
      }
      return await createSession(sessionOptions);
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
    return sessionPromise;
  }

  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const s = await session();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = normalizeHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = init?.body ?? (input instanceof Request ? input.body : undefined);
    const timeout = bodyRequestsStreaming(body) ? 0 : (options.timeoutMs ?? 0);
    return await s.fetch(url, {
      method,
      headers,
      disableDefaultHeaders: true,
      timeout,
      ...(body !== undefined && body !== null ? { body } : {}),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  }) as typeof globalThis.fetch;
}
