import { Agent, setGlobalDispatcher } from "undici";

// Upstream egress tuning (perf). Provider clients call `globalThis.fetch` (undici)
// with no per-request dispatcher, so every upstream call rides undici's PROCESS-GLOBAL
// Agent. Its default keep-alive timeout is short (4s), so under bursty LLM traffic
// idle sockets close and the next call pays a fresh TLS handshake. We install ONE
// tuned global Agent at boot with a longer keep-alive so connections to each upstream
// origin are reused. The pool SIZE (`connections`) is left at undici's default unless
// an operator explicitly sets it — we never shrink the pool implicitly.
//
// This must run ONCE at process start (it is a process global; it cannot be per
// request or set inside buildServer). Per-account proxy clients pass their OWN
// dispatcher (provider/proxy.ts), so this global never overrides a proxied call.

export interface EgressAgentOptions {
  keepAliveTimeout: number;
  keepAliveMaxTimeout: number;
  // Max connections per origin. Omitted (undefined) → undici default. Only set when
  // HELM_UNDICI_CONNECTIONS is an explicit positive integer.
  connections?: number;
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function buildEgressAgentOptions(
  env: Record<string, string | undefined>,
): EgressAgentOptions {
  const connRaw = Number(env.HELM_UNDICI_CONNECTIONS);
  const opts: EgressAgentOptions = {
    keepAliveTimeout: positive(env.HELM_UNDICI_KEEPALIVE_MS, 30_000),
    keepAliveMaxTimeout: positive(env.HELM_UNDICI_KEEPALIVE_MAX_MS, 60_000),
  };
  if (Number.isFinite(connRaw) && connRaw > 0) opts.connections = connRaw;
  return opts;
}

// Install the tuned global dispatcher. Side-effecting; call once at boot.
export function configureEgress(env: Record<string, string | undefined>): void {
  setGlobalDispatcher(new Agent(buildEgressAgentOptions(env)));
}
