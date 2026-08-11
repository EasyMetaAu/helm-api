// Admin "Test account" surface (per-account connectivity check for the Subscription
// Providers page). Two framework-free pieces, kept here so they unit-test without
// Hono or the composition root:
//
//   1. createOpenAiStreamParser — a buffering parser that turns the provider
//      client's streamed OpenAI `chat.completion.chunk` SSE into a tiny normalized
//      event stream (content / finish / usage). Every executor-backed OAuth client
//      (Anthropic, Codex, Copilot) yields OpenAI-shaped chunks (the protocol layer
//      normalizes upstream Anthropic/Responses frames), so ONE parser covers all.
//
//   2. createOAuthAccountTester — given a `buildClient` seam that mints a FRESH,
//      standalone per-account client (its own token + proxy + executor type, and —
//      crucially — its OWN, no-op circuit breaker), it streams a single short user
//      turn and yields the normalized events. Building a fresh client means the test
//      records NO telemetry / request_payloads and never perturbs the live routing
//      pool's breaker state (the breaker lives in the executor layer, not the raw
//      client). The anti-ban shaping (Claude-Code system spoof + stable identity)
//      rides inside the provider client, so a bare user turn is accepted by Claude
//      Max / Codex OAuth unchanged.

import type { ChatCompletionRequest, ProviderClient } from "@helm/core";

// The normalized event the admin UI renders. `content` deltas stream into the
// response box; `finish`/`usage` are metadata the dialog may surface. Reasoning
// deltas are intentionally dropped (a connectivity test shows the visible answer).
export type TestStreamEvent =
  | { type: "content"; text: string }
  | { type: "finish"; reason?: string }
  | {
      type: "usage";
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };

// A short, cheap prompt — enough to prove the credential routes and streams, with a
// low token cap so a test costs almost nothing. Both overridable by the caller.
export const DEFAULT_TEST_PROMPT = "Hi! Reply with a short one-sentence greeting.";
export const DEFAULT_TEST_MAX_TOKENS = 512;
export const OAUTH_TEST_MAX_SSE_LINE_BYTES = 1024 * 1024;

export interface OpenAiStreamParser {
  // Feed a raw decoded body chunk (NOT necessarily frame-aligned). Returns the
  // events completed by this chunk.
  push(chunk: string): TestStreamEvent[];
  // Drain a trailing frame that arrived without a final newline (some upstreams
  // close the socket right after the last `data:` line).
  flush(): TestStreamEvent[];
}

// Pull the normalized events out of ONE parsed chunk object. A single frame can
// carry a content delta AND a finish_reason AND (on the terminal frame) usage.
function eventsFromChunk(json: unknown): TestStreamEvent[] {
  if (typeof json !== "object" || json === null) return [];
  const obj = json as { choices?: unknown; usage?: unknown };
  const out: TestStreamEvent[] = [];

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = choices[0] as { delta?: unknown; finish_reason?: unknown } | undefined;
  if (first) {
    const delta = (first.delta ?? {}) as { content?: unknown };
    if (typeof delta.content === "string" && delta.content.length > 0) {
      out.push({ type: "content", text: delta.content });
    }
    if (typeof first.finish_reason === "string" && first.finish_reason.length > 0) {
      out.push({ type: "finish", reason: first.finish_reason });
    }
  }

  const usage = obj.usage as
    | { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
    | undefined;
  if (usage && typeof usage === "object") {
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    out.push({
      type: "usage",
      promptTokens: num(usage.prompt_tokens),
      completionTokens: num(usage.completion_tokens),
      totalTokens: num(usage.total_tokens),
    });
  }
  return out;
}

export function createOpenAiStreamParser(): OpenAiStreamParser {
  let buffer = "";

  function assertLineFits(line: string): void {
    if (Buffer.byteLength(line, "utf8") <= OAUTH_TEST_MAX_SSE_LINE_BYTES) return;
    buffer = "";
    throw new Error(`OAuth test SSE line exceeds ${OAUTH_TEST_MAX_SSE_LINE_BYTES} bytes`);
  }

  // Parse ONE complete SSE line. Non-`data:` lines (comments `:`, blank lines,
  // `event:` fields) and `[DONE]` / unparseable payloads are ignored (fail-open —
  // a malformed frame must never abort the test stream).
  function handleLine(line: string): TestStreamEvent[] {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text.startsWith("data:")) return [];
    const payload = text.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return [];
    try {
      return eventsFromChunk(JSON.parse(payload));
    } catch {
      return [];
    }
  }

  return {
    push(chunk: string): TestStreamEvent[] {
      buffer += chunk;
      const out: TestStreamEvent[] = [];
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        assertLineFits(line);
        out.push(...handleLine(line));
        nl = buffer.indexOf("\n");
      }
      assertLineFits(buffer);
      return out;
    },
    flush(): TestStreamEvent[] {
      const rest = buffer;
      buffer = "";
      assertLineFits(rest);
      return rest.length > 0 ? handleLine(rest) : [];
    },
  };
}

export interface OAuthTestParams {
  providerId: string;
  account: string;
  // An upstream model id from the account's effective routable set (UI-supplied).
  model: string;
  // Optional operator-typed prompt; blank ⇒ DEFAULT_TEST_PROMPT.
  prompt?: string;
  // Client-disconnect / modal-close propagation (an abort is not a failure).
  signal?: AbortSignal;
}

export interface OAuthTester {
  test(params: OAuthTestParams): AsyncIterable<TestStreamEvent>;
}

export interface OAuthAccountTesterDeps {
  // Mint a FRESH standalone client for (providerId, account), or null when the
  // account is not connected / cannot be built. The gateway wires this to the same
  // per-account binding synthesis uses (proxy + identity + executor type) so the
  // test path is faithful to production routing.
  buildClient(providerId: string, account: string): Promise<ProviderClient | null>;
  defaultPrompt?: string;
  maxTokens?: number;
}

export function createOAuthAccountTester(deps: OAuthAccountTesterDeps): OAuthTester {
  const defaultPrompt = deps.defaultPrompt ?? DEFAULT_TEST_PROMPT;
  const maxTokens = deps.maxTokens ?? DEFAULT_TEST_MAX_TOKENS;
  return {
    async *test({ providerId, account, model, prompt, signal }): AsyncIterable<TestStreamEvent> {
      const client = await deps.buildClient(providerId, account);
      if (!client) throw new Error(`account "${account}" is not connected`);
      const content = (prompt ?? "").trim() || defaultPrompt;
      const req: ChatCompletionRequest = {
        model,
        messages: [{ role: "user", content }],
        stream: true,
        max_tokens: maxTokens,
      };
      const parser = createOpenAiStreamParser();
      for await (const chunk of client.chatCompletionStream(req, { signal })) {
        for (const ev of parser.push(chunk)) yield ev;
      }
      for (const ev of parser.flush()) yield ev;
    },
  };
}
