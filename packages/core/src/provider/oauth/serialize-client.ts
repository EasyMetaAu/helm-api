// Serializing decorator around ONE OAuth pool member's client (issue #93,
// feature B — the "user message serial queue"). Wraps the member AFTER pool
// selection so the gate key is the concrete account that will serve the call.
//
// Semantics (CRS parity, user decision): only requests whose LAST message is a
// genuine user turn are serialized — at most one in flight per account, and the
// next starts >= delayMs after the previous one FULLY completed. For streaming
// that means the lock is held until the consumer drains (or abandons) the
// iterator: the wrapping generator's `finally` is the release point.
//
// Failure shape: a wait timeout throws QueueTimeoutError (the executor maps it
// to lane_unavailable → 503, records NO breaker failure — backpressure is not
// provider health). A client abort during the wait rethrows as AbortError (the
// executor's normal disconnect path). Any UNEXPECTED gate error fails OPEN: the
// request flows unserialized with a warn (principle 3 — an auxiliary mechanism
// must never 5xx a request).

import { nativePassthroughBody } from "@helm/shared";
import type { KeyedSerialGate, SerialAcquireResult } from "../../queue/keyed-serial-gate.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderClient } from "../openai.js";

// Distinguishable failure for "the per-account queue wait timed out". Carries a
// flag (not just the class) so an instanceof across package boundaries is not
// load-bearing.
export class QueueTimeoutError extends Error {
  readonly queueTimeout = true as const;
  constructor(message: string) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}

export interface SerializeClientDeps {
  inner: ProviderClient;
  gate: Pick<KeyedSerialGate, "acquire">;
  // Gate key for this member — `${providerId} ${account}` (the same composite
  // the account-settings store uses).
  key: string;
  // Live settings thunk: read per call so an admin toggle applies immediately,
  // with no pool rebuild and no effect on already-queued waiters' own delays.
  getConfig: () => { enabled: boolean; delayMs: number; timeoutMs: number };
  isUserMessage: (req: ChatCompletionRequest) => boolean;
  log?: (level: "warn" | "info", msg: string, fields?: Record<string, unknown>) => void;
}

type Lease = { release: () => void } | null;

export function createSerializingClient(deps: SerializeClientDeps): ProviderClient {
  // Acquire the serial lock for a user-message call. Returns:
  //   - null            => not serialized (disabled / not a user turn / gate
  //                        internal error → fail-open)
  //   - { release }     => serialized; caller MUST release at full completion
  // Throws QueueTimeoutError / AbortError for the two by-design failures.
  async function admit(req: ChatCompletionRequest, signal?: AbortSignal): Promise<Lease> {
    const config = deps.getConfig();
    if (!config.enabled || !deps.isUserMessage(req)) return null;
    let result: SerialAcquireResult;
    try {
      result = await deps.gate.acquire({
        key: deps.key,
        delayMs: config.delayMs,
        timeoutMs: config.timeoutMs,
        signal,
      });
    } catch (err) {
      // Fail-open (principle 3): an internal queue fault must never block the
      // request — let it flow unserialized and surface the fault in the logs.
      deps.log?.("warn", "queue.user_message.gate_error_fail_open", {
        key: deps.key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (result.ok) return { release: result.release };
    if (result.reason === "aborted") {
      const abort = new Error("client aborted while waiting in the user message queue");
      abort.name = "AbortError";
      throw abort;
    }
    throw new QueueTimeoutError(
      `user message queue wait exceeded ${config.timeoutMs}ms for ${deps.key}`,
    );
  }

  const client: ProviderClient = {
    async chatCompletion(
      req: ChatCompletionRequest,
      opts?: { signal?: AbortSignal },
    ): Promise<ChatCompletionResponse> {
      const lease = await admit(req, opts?.signal);
      if (lease === null) return deps.inner.chatCompletion(req, opts);
      try {
        return await deps.inner.chatCompletion(req, opts);
      } finally {
        lease.release();
      }
    },

    chatCompletionStream(
      req: ChatCompletionRequest,
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<string> {
      // Lazy wrapper: the lock is acquired on FIRST iteration (the executor's
      // first-chunk peek) and held until the consumer fully drains, breaks, or
      // errors — the generator `finally` is the single release point, so the
      // delay is measured from the true completion instant (CRS parity).
      return (async function* () {
        const lease = await admit(req, opts?.signal);
        if (lease === null) {
          yield* deps.inner.chatCompletionStream(req, opts);
          return;
        }
        try {
          yield* deps.inner.chatCompletionStream(req, opts);
        } finally {
          lease.release();
        }
      })();
    },
  };

  // Native protocol passthrough (issue #217): the same serial-queue discipline must
  // wrap a verbatim-native call, so a subscription account still serves at most one
  // user turn in flight whether the body was translated or forwarded. Expose these
  // ONLY when the wrapped member actually implements them, so the pool's
  // feature-detect (`typeof member.client.nativePassthrough === "function"`) stays
  // truthful — an inner that can't passthrough must not appear to via this decorator.
  const innerNative = deps.inner.nativePassthrough;
  if (innerNative) {
    client.nativePassthrough = async (req, opts) => {
      const lease = await admit(nativePassthroughBody(req), opts?.signal);
      if (lease === null) return innerNative(req, opts);
      try {
        return await innerNative(req, opts);
      } finally {
        lease.release();
      }
    };
  }

  const innerNativeStream = deps.inner.nativePassthroughStream;
  if (innerNativeStream) {
    client.nativePassthroughStream = (req, opts) =>
      (async function* () {
        const lease = await admit(nativePassthroughBody(req), opts?.signal);
        if (lease === null) {
          yield* innerNativeStream(req, opts);
          return;
        }
        try {
          yield* innerNativeStream(req, opts);
        } finally {
          lease.release();
        }
      })();
  }

  const innerCompact = deps.inner.responsesCompact;
  if (innerCompact) {
    client.responsesCompact = async (req, opts) => {
      const lease = await admit(nativePassthroughBody(req), opts?.signal);
      if (lease === null) return innerCompact(req, opts);
      try {
        return await innerCompact(req, opts);
      } finally {
        lease.release();
      }
    };
  }

  const innerRealtime = deps.inner.realtimeCall;
  if (innerRealtime) {
    client.realtimeCall = (req, opts) => innerRealtime(req, opts);
  }

  if (deps.inner.closeResponsesWebSocketSession) {
    client.closeResponsesWebSocketSession = (sessionId) =>
      deps.inner.closeResponsesWebSocketSession?.(sessionId) ?? Promise.resolve();
  }

  // Forward the inner member's wire-protocol profile verbatim. This is a DATA field,
  // not a method, so the method-by-method decoration above would otherwise drop it —
  // and a dropped profile made a multi-account pool report `undefined` (pool.ts only
  // exposes a pool profile when every member agrees), silently disabling the
  // executor's generic-Responses cross-protocol guard (`candidateGuardSkipReason`).
  if (deps.inner.nativeProtocolProfile !== undefined) {
    client.nativeProtocolProfile = deps.inner.nativeProtocolProfile;
  }

  return client;
}
