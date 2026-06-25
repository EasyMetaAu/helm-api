import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

// A local stand-in for an OpenAI-compatible upstream. Deterministic, offline.
//
// Behaviour (all CI-reproducible — no network, no clock dependence):
//  • Non-stream: returns a fixed chat.completion JSON, but ECHOES the request's
//    `model` back as `model` so the gateway's resolved provider model is
//    observable end-to-end (routing-signal assertion).
//  • Stream: returns text/event-stream with delta chunks + [DONE].
//  • Error injection: the gateway only forwards `model` + `messages` (+ a few
//    standard fields) to the upstream — NOT arbitrary client headers. So the
//    fault is steered through the PROMPT: when a message contains the sentinel
//    `FAIL_PRIMARY_SENTINEL`, the mock returns 5xx for `FAIL_PRIMARY_MODEL`
//    (the economy lane head, the request's PRIMARY candidate) and serves every
//    other model normally. The gateway then retries the next in-chain candidate
//    (a different model) → EXECUTION fallback, deterministic and self-contained.

// Base body shape. `model` is overwritten per-request with the echoed model.
const BASE_RESPONSE = {
  id: "chatcmpl-mock",
  object: "chat.completion",
  model: "mock-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" },
  ],
};

// Backwards-compatible export: the canonical non-stream body for a request whose
// model is the default `mock-model` (used by the smoke passthrough test, which
// sends a model the gateway forwards verbatim under explicit passthrough).
export const NONSTREAM_RESPONSE = BASE_RESPONSE;

// Build the echoed non-stream body for a given model id.
export function echoResponse(model: string) {
  return { ...BASE_RESPONSE, model };
}

// Prompt sentinel + the model it fails. A message carrying the sentinel makes
// the mock 5xx ONLY the economy lane head (the primary candidate), forcing the
// gateway to fall forward to the next in-chain candidate. Exported so the spec
// and the mock stay in lockstep.
//
// The economy lane head is the alias `deepseek/deepseek-v4-flash`, whose RESOLVED
// provider_model is the BARE upstream id `deepseek-v4-flash` (alias != provider_
// model — the upstream accepts the bare id). The gateway forwards that resolved
// provider_model upstream as `model`, so the mock must match on the BARE id. Keep
// in lockstep with config/providers.yaml's `provider_model` for config/lanes.yaml
// `economy.primary`.
export const FAIL_PRIMARY_SENTINEL = "__HELM_FAIL_PRIMARY__";
export const FAIL_PRIMARY_MODEL = "deepseek-v4-flash";

function messagesText(body: { messages?: unknown }): string {
  if (!Array.isArray(body.messages)) return "";
  let text = "";
  for (const m of body.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") text += content;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") text += part;
        else if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          text += (part as { text: string }).text;
        }
      }
    }
  }
  return text;
}

export const STREAM_CHUNKS = [
  'data: {"id":"chatcmpl-mock","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"id":"chatcmpl-mock","choices":[{"delta":{"content":"hel"}}]}\n\n',
  'data: {"id":"chatcmpl-mock","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

// —— tool-call scripts (e2e.protocol) ————————————————————————————————————————
// A prompt carrying TOOL_CALL_SENTINEL makes the mock answer with an OpenAI
// function tool_call instead of plain text — exercising the tool-call branch of
// both protocol directions. The stream variant FRAGMENTS the arguments across
// chunks and supplies the id/name only on the FIRST fragment, so the gateway's
// streaming state machine (docs/05 pit #3) has to coordinate index/id and
// accumulate partial JSON. Kept here so the spec and the mock stay in lockstep.
export const TOOL_CALL_SENTINEL = "__HELM_TOOL_CALL__";
const TOOL_CALL_ID = "call_mock_weather";
const TOOL_CALL_NAME = "get_weather";

// Non-stream OpenAI tool_call completion.
function toolCallResponse(model: string) {
  return {
    id: "chatcmpl-mock-tool",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: TOOL_CALL_ID,
              type: "function",
              function: { name: TOOL_CALL_NAME, arguments: '{"city":"Paris"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

// Streamed OpenAI tool_call chunks: id+name on the FIRST fragment, then the JSON
// arguments split across two fragments, then finish_reason + [DONE].
export const TOOL_CALL_STREAM_CHUNKS = [
  'data: {"id":"chatcmpl-mock-tool","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  `data: {"id":"chatcmpl-mock-tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"${TOOL_CALL_ID}","type":"function","function":{"name":"${TOOL_CALL_NAME}","arguments":"{\\"city\\":"}}]}}]}\n\n`,
  'data: {"id":"chatcmpl-mock-tool","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}\n\n',
  'data: {"id":"chatcmpl-mock-tool","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
];

// —— Layer-2 eval small-model stand-in (e2e.eval) ————————————————————————————
// The same mock doubles as the internal "eval small-model". The gateway routes
// Layer-2 eval calls to the SAME upstream base_url with the configured eval model
// id. The mock recognizes an eval call by the eval SYSTEM-PROMPT marker (the
// classify instruction), NOT by the model id — the eval model may be a real model
// that also backs a lane (fix-upstream-model-id 2026-05-31). It then behaves as a
// controllable judge:
//   • NORMAL  → returns a valid strict-JSON EvalOutput that drives a specific
//     lane. We emit complexity:"reasoning" so the cascade resolves the PREMIUM
//     lane — deliberately DIFFERENT from the `balanced` fail-open default, so the
//     e2e can prove "eval really changed the lane".
//   • SLOW    → when the prompt carries EVAL_SLOW_SENTINEL, the judge delays past
//     the eval timeout, exercising the double-timeout fail-open (→ balanced).
//   • COUNTING→ every eval call increments a counter the spec reads back
//     (EVAL_CALL_COUNT_PATH) — the hardest external evidence for cache hits
//     (a hit must NOT increment) and hit-stop (rules-confident must not call).
// The judge NEVER sees a plaintext key/payload echoed (principle 7); it only
// reads the prompt text to decide normal vs slow.
// Stable substring of the eval system prompt (apps/gateway/src/routes/classify.ts
// buildEvalPrompt). Only the Layer-2 classify call sends it, so the mock can
// discriminate eval calls without coupling to the model id.
export const EVAL_PROMPT_MARKER = "Classify the request.";
export const EVAL_SLOW_SENTINEL = "__HELM_EVAL_SLOW__";
// Delay (ms) the slow judge sleeps before answering — comfortably past BOTH e2e
// eval timeouts (inner timeout_ms 3000 / outer outer_timeout_ms 4000) so the
// fail-open path is deterministic regardless of which timeout fires. The eval
// returns at the inner timeout (~3000ms); this delay only keeps the mock from
// answering first, so raising it does NOT slow the test wall-clock.
const EVAL_SLOW_DELAY_MS = 5_000;
// Strict EvalOutput the NORMAL judge returns → complexity:reasoning → premium.
const EVAL_OUTPUT_JSON = JSON.stringify({
  complexity: "reasoning",
  task_type: "math",
  confidence: 0.91,
});
// Counter read-back + reset endpoints (spec drives these on the mock, not the
// gateway baseURL).
export const EVAL_CALL_COUNT_PATH = "/__eval_count";
export const EVAL_RESET_PATH = "/__eval_reset";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// —— OAuth subscription provider stand-in (e2e.oauth, issue #38) ——————————————
// The same mock doubles as an OAuth token endpoint + a credential-checked upstream.
//   • POST OAUTH_TOKEN_PATH → issues a fresh access token (monotonic counter so the
//     spec can prove a refresh happened). The mock counts every token mint.
//   • /chat/completions checks the Authorization Bearer: a request whose prompt
//     carries OAUTH_401_ONCE_SENTINEL is answered 401 the FIRST time and 200
//     afterwards — exercising the client's invalidate + single-retry-with-fresh-
//     token path (the retry mints a new token, then succeeds).
// All env-NAME-only, deterministic, offline.
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_BEARER_PREFIX = "mock-oauth-access-";
export const OAUTH_TOKEN_COUNT_PATH = "/__oauth_token_count";
export const OAUTH_RESET_PATH = "/__oauth_reset";
// A prompt carrying this sentinel makes the mock 401 the FIRST chat call (per
// process), forcing the OAuth client to refresh + retry exactly once.
export const OAUTH_401_ONCE_SENTINEL = "__HELM_OAUTH_401_ONCE__";

// —— upstream request capture (e2e.protocol) —————————————————————————————————
// The path the spec GETs to read back the LAST request the gateway forwarded
// upstream. Lets the e2e assert the NORMALIZED (OpenAI-Chat IR) request shape
// for BOTH client directions — proving nativeIn → IR → nativeOut.
export const CAPTURE_PATH = "/__captured";

export interface UpstreamCapture {
  body: { model?: string; messages: unknown[]; [k: string]: unknown };
  count: number;
}

export function createMockUpstream() {
  const app = new Hono();
  // The last request the gateway forwarded upstream + a monotonic counter. Lets
  // the e2e read back the NORMALIZED request shape (CAPTURE_PATH).
  let lastCapture: UpstreamCapture = { body: { messages: [] }, count: 0 };
  // Layer-2 eval call counter (e2e.eval). Incremented on EVERY eval-model call,
  // BEFORE any slow-path delay, so a timed-out call still counts (the spec
  // asserts a fail-open is re-called, not cached).
  let evalCallCount = 0;
  // OAuth token mints (e2e.oauth). Incremented on every token endpoint POST so the
  // spec can prove a refresh happened (a 401-retry mints a second token).
  let oauthTokenCount = 0;
  // Whether the OAuth-401-once branch has already fired in THIS process. Reset via
  // OAUTH_RESET_PATH between spec cases.
  let oauth401Fired = false;

  // Readiness probe for Playwright's webServer wait.
  app.get("/", (c) => c.text("mock upstream ok"));
  // Read back the last normalized upstream request (e2e.protocol assertions).
  app.get(CAPTURE_PATH, (c) => c.json(lastCapture));
  // Eval-endpoint call count read-back + reset (e2e.eval).
  app.get(EVAL_CALL_COUNT_PATH, (c) => c.json({ count: evalCallCount }));
  app.post(EVAL_RESET_PATH, (c) => {
    evalCallCount = 0;
    return c.json({ ok: true });
  });

  // OAuth token endpoint (e2e.oauth): mint a fresh access token each call. The
  // token id encodes the mint count so the spec / mock can prove a refresh.
  app.post(OAUTH_TOKEN_PATH, async (c) => {
    oauthTokenCount += 1;
    // Drain the body (grant_type/client_id/…) so the connection closes cleanly;
    // we never echo it (it carries the client secret / refresh token).
    await c.req.text().catch(() => "");
    return c.json({
      access_token: `${OAUTH_BEARER_PREFIX}${oauthTokenCount}`,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  app.get(OAUTH_TOKEN_COUNT_PATH, (c) => c.json({ count: oauthTokenCount }));
  app.post(OAUTH_RESET_PATH, (c) => {
    oauthTokenCount = 0;
    oauth401Fired = false;
    return c.json({ ok: true });
  });

  app.post("/chat/completions", async (c) => {
    const body = (await c.req.json()) as {
      stream?: boolean;
      model?: unknown;
      messages?: unknown;
    };
    const model = typeof body.model === "string" ? body.model : "mock-model";

    const promptText = messagesText(body);

    // ── OAuth 401-once branch (e2e.oauth, issue #38): a request carrying the
    //    sentinel is answered 401 the FIRST time, forcing the gateway's OAuth
    //    client to invalidate + refresh + retry exactly once. The retry mints a
    //    new token and is served normally. We also assert the Authorization header
    //    is the mock-issued Bearer (never a plaintext static key).
    if (promptText.includes(OAUTH_401_ONCE_SENTINEL)) {
      const auth = c.req.header("authorization") ?? "";
      if (!auth.startsWith(`Bearer ${OAUTH_BEARER_PREFIX}`)) {
        return c.json({ error: { message: "missing oauth bearer" } }, 401);
      }
      if (!oauth401Fired) {
        oauth401Fired = true;
        return c.json({ error: { message: "token expired" } }, 401);
      }
      return c.json(echoResponse(model));
    }

    // ── Layer-2 eval branch: the request is the internal classify call. We key
    //    on the eval SYSTEM-PROMPT marker ("Classify the request.", see
    //    apps/gateway/src/routes/classify.ts) — NOT the model id — so the eval
    //    model can be a real model that ALSO serves a lane (e.g. deepseek-v4-flash)
    //    without the mock mistaking a normal routed request for an eval call
    //    (fix-upstream-model-id 2026-05-31). Returns a strict JSON judgment; the
    //    slow sentinel makes it exceed the eval timeout.
    if (promptText.includes(EVAL_PROMPT_MARKER)) {
      evalCallCount += 1; // count BEFORE any delay so timed-out calls still count
      if (promptText.includes(EVAL_SLOW_SENTINEL)) {
        await sleep(EVAL_SLOW_DELAY_MS);
      }
      return c.json({
        id: "chatcmpl-eval",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: EVAL_OUTPUT_JSON },
            finish_reason: "stop",
          },
        ],
      });
    }

    // Record the normalized request so the e2e can assert nativeIn → IR → nativeOut.
    // (eval calls are excluded — capture tracks the MAIN routed request only.)
    lastCapture = {
      body: body as UpstreamCapture["body"],
      count: lastCapture.count + 1,
    };

    // Error injection (prompt-steered): a sentinel in the prompt fails ONLY the
    // economy head (primary candidate) so the gateway falls forward to the next
    // candidate in the chain (EXECUTION fallback).
    if (promptText.includes(FAIL_PRIMARY_SENTINEL) && model === FAIL_PRIMARY_MODEL) {
      return c.json(
        { error: { message: "mock injected upstream error", type: "server_error" } },
        500,
      );
    }

    // Tool-call branch (prompt-steered): emit an OpenAI function tool_call.
    if (promptText.includes(TOOL_CALL_SENTINEL)) {
      if (body.stream === true) {
        return streamSSE(c, async (sse) => {
          for (const chunk of TOOL_CALL_STREAM_CHUNKS) await sse.write(chunk);
        });
      }
      return c.json(toolCallResponse(model));
    }

    if (body.stream === true) {
      return streamSSE(c, async (sse) => {
        for (const chunk of STREAM_CHUNKS) await sse.write(chunk);
      });
    }
    // Echo the model so the gateway's resolved provider model is observable.
    return c.json(echoResponse(model));
  });
  return app;
}

// Run standalone (used as the e2e mock process). PORT via MOCK_PORT.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT ?? "8181");
  serve({ fetch: createMockUpstream().fetch, port, hostname: "127.0.0.1" });
  // eslint-disable-next-line no-console
  process.stdout.write(`mock upstream listening on ${port}\n`);
}
