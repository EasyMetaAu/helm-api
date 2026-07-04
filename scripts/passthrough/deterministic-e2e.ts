import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { strict as assert } from "node:assert";
import { createNativePassthroughCarrier } from "../../packages/shared/src/native-passthrough.js";
import { createApp } from "../../apps/gateway/src/app.js";
import { registerMessagesRoute, type MessagesRouteDeps } from "../../apps/gateway/src/routes/messages.js";
import { registerResponsesRoute, type ResponsesRouteDeps } from "../../apps/gateway/src/routes/responses.js";
import { createAnthropicClient } from "../../packages/core/src/provider/anthropic.js";
import { createCodexResponsesClient } from "../../packages/core/src/provider/openai-responses.js";
import { createCircuitBreaker } from "../../packages/core/src/circuit/breaker.js";
import type { ProviderClient } from "../../packages/core/src/provider/openai.js";
import type { ProviderRegistry } from "../../packages/core/src/provider/registry.js";
import type { InternalRequest, TargetProviderProtocol } from "../../packages/shared/src/request/schema.js";
import { createExecute } from "../../apps/gateway/src/routes/execute.js";

interface CapturedUpstreamRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  rawBody: Buffer;
  parsedBody?: unknown;
}

type Handler = (captured: CapturedUpstreamRequest, res: ServerResponse) => void;

function lowerHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function jsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sseResponse(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function withFakeUpstream<T>(handler: Handler, run: (baseUrl: string, captured: CapturedUpstreamRequest[]) => Promise<T>): Promise<T> {
  const captured: CapturedUpstreamRequest[] = [];
  const server = createServer(async (req, res) => {
    try {
      const rawBody = await readBody(req);
      const record: CapturedUpstreamRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string | string[]>,
        rawBody,
      };
      try {
        record.parsedBody = JSON.parse(rawBody.toString("utf8"));
      } catch {
        // Raw bytes are the assertion target for malformed or non-JSON fixtures.
      }
      captured.push(record);
      handler(record, res);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert(addr && typeof addr === "object", "fake upstream did not bind a TCP port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await run(baseUrl, captured);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function jwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iterable) out += chunk;
  return out;
}

function registry(args: {
  alias: string;
  providerName: string;
  providerModel: string;
  targetProviderProtocol: TargetProviderProtocol;
}): ProviderRegistry {
  return {
    resolve(alias: string) {
      if (alias !== args.alias) return { ok: false, error: { kind: "unknown_alias", alias } };
      return {
        ok: true,
        value: {
          alias,
          providerName: args.providerName,
          providerModel: args.providerModel,
          baseUrl: "http://fake",
          apiKeyEnv: "FAKE",
          targetProviderProtocol: args.targetProviderProtocol,
          providerRequiresCompatibilityRewrite: false,
        },
      };
    },
    list: () => [args.alias],
  };
}

function internalRequest(over: Partial<InternalRequest>): InternalRequest {
  return {
    request_id: "passthrough-e2e",
    protocol: "anthropic_messages",
    account_id: "acct",
    api_key_id: "key",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content: "hi" }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: null,
    stream: false,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
    ...over,
  };
}

function executeWithProvider(args: {
  alias: string;
  providerName: string;
  providerModel: string;
  targetProviderProtocol: TargetProviderProtocol;
  provider: ProviderClient;
}) {
  return createExecute({
    defaultProvider: args.provider,
    providers: new Map([[args.providerName, args.provider]]),
    registry: registry(args),
    breaker: createCircuitBreaker({ config: { failureThreshold: 5, cooldownMs: 1_000 } }),
    catalog: new Map(),
    now: () => 0,
    signal: new AbortController().signal,
    nativeProtocolPassthroughEnabled: () => true,
  });
}

const ROUTE_DECISION = { final: { status: "ok", model_alias: "native-route" } } as never;

function routeApp() {
  return createApp({ logger: { log: () => {} }, genTraceId: () => "trace-route-passthrough" });
}

async function* rawSseFrames(raw: string): AsyncIterable<Record<string, unknown>> {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const block of normalized.split("\n\n")) {
    if (block === "") continue;
    const frameRaw = `${block}\n\n`;
    let event = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).replace(/^ /, "");
      else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) {
      yield { raw: frameRaw };
    } else {
      yield { event, data: dataLines.join("\n"), raw: frameRaw };
    }
  }
}

function messagesErrorOut(err: {
  error_class: string;
  message: string;
  trace_id: string;
}): { status: number; body: unknown } {
  const status =
    err.error_class === "auth_error"
      ? 401
      : err.error_class === "invalid_request"
        ? 400
        : err.error_class === "rate_limited"
          ? 429
          : 502;
  return {
    status,
    body: { type: "error", error: { type: err.error_class, message: err.message } },
  };
}

function routeRejectLimiter() {
  return {
    check: async () => ({
      allowed: false,
      limit: 1,
      remaining: 0,
      resetSeconds: 60,
      retryAfterSeconds: 60,
      limitedBy: "rpm" as const,
    }),
  };
}

async function testAnthropicNonStream(): Promise<void> {
  const rawBody = '{\n  "model":"claude-client-alias",\n  "max_tokens":8,\n  "messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],\n  "future_field":{"nested":true}\n}';
  const upstream = {
    id: "msg_passthrough_acceptance",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  await withFakeUpstream(
    (captured, res) => {
      assert.equal(captured.url, "/v1/messages");
      jsonResponse(res, upstream);
    },
    async (baseUrl, captured) => {
      const carrier = createNativePassthroughCarrier({
        protocol: "anthropic_messages",
        body: JSON.parse(rawBody) as Record<string, unknown>,
        rawBody,
        headers: {
          authorization: "Bearer helm-client-key",
          "x-api-key": "client-upstream-key",
          "x-helm-trace-id": "trace-client",
          connection: "keep-alive",
          "content-length": "999",
          "accept-language": "en-US",
          "anthropic-beta": "client-beta",
        },
      });
      const client = createAnthropicClient({
        config: { baseUrl, apiKey: "provider-anthropic-key", timeoutMs: 2_000 },
      });

      const response = await client.nativePassthrough?.(carrier);
      assert.deepEqual(response, upstream);
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.rawBody.toString("utf8"), rawBody);
      const headers = lowerHeaders(captured[0]?.headers ?? {});
      assert.equal(headers["x-api-key"], "provider-anthropic-key");
      assert.equal(headers["authorization"], undefined);
      assert.equal(headers["x-helm-trace-id"], undefined);
      assert.equal(headers["accept-language"], "en-US");
      assert.equal(carrier.mutations.auth_replaced, true);
      assert.equal(JSON.stringify(carrier.mutations).includes("helm-client-key"), false);
    },
  );
}

async function testAnthropicExecuteModelRewrite(): Promise<void> {
  const clientBody = {
    model: "anthropic/claude-client-alias",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
    future_field: { nested: true },
  };
  const upstream = {
    id: "msg_rewrite_acceptance",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  await withFakeUpstream(
    (_captured, res) => jsonResponse(res, upstream),
    async (baseUrl, captured) => {
      const carrier = createNativePassthroughCarrier({
        protocol: "anthropic_messages",
        body: clientBody,
        rawBody: JSON.stringify(clientBody),
        headers: { "x-api-key": "client-key", "x-client-feature": "keep" },
      });
      const provider = createAnthropicClient({
        config: { baseUrl, apiKey: "provider-key", timeoutMs: 2_000 },
      });
      const execute = executeWithProvider({
        alias: "a",
        providerName: "anthropic",
        providerModel: "claude-upstream",
        targetProviderProtocol: "anthropic_messages",
        provider,
      });

      const out = await execute(
        { selected_lane: "balanced", candidate_chain: ["a"], explicit_model: null },
        internalRequest({
          protocol: "anthropic_messages",
          native_request: carrier,
        }),
      );

      assert.equal(out.nativePassthrough, true);
      assert.equal(captured.length, 1);
      const parsed = captured[0]?.parsedBody as Record<string, unknown>;
      assert.equal(parsed.model, "claude-upstream");
      assert.deepEqual(parsed.future_field, { nested: true });
      assert.deepEqual(carrier.mutations.model_rewritten, {
        from: "anthropic/claude-client-alias",
        to: "claude-upstream",
      });
      assert.equal(out.attempts[0]?.passthrough_mutations?.model_rewritten?.to, "claude-upstream");
    },
  );
}

async function testAnthropicStreamSafetyHeaders(): Promise<void> {
  const rawBody =
    '{"model":"claude-upstream","stream":true,"max_tokens":8,"messages":[{"role":"user","content":"hi"}]}';
  const upstreamSse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream"}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  await withFakeUpstream(
    (_captured, res) => sseResponse(res, upstreamSse),
    async (baseUrl, captured) => {
      const carrier = createNativePassthroughCarrier({
        protocol: "anthropic_messages",
        body: JSON.parse(rawBody) as Record<string, unknown>,
        rawBody,
        headers: {
          "accept-encoding": "br, gzip",
          "anthropic-beta": "client-beta",
          "x-client-feature": "keep",
        },
      });
      const client = createAnthropicClient({
        config: { baseUrl, getAuthHeader: async () => "Bearer provider-oauth", timeoutMs: 2_000 },
      });

      const response = await collect(client.nativePassthroughStream?.(carrier) ?? []);

      assert.equal(response, upstreamSse);
      assert.equal(captured.length, 1);
      const headers = lowerHeaders(captured[0]?.headers ?? {});
      assert.equal(headers["accept-encoding"], "identity");
      assert.equal(headers["x-client-feature"], "keep");
      assert.equal(headers["anthropic-beta"]?.includes("client-beta"), true);
      assert.equal(carrier.mutations.accept_encoding_forced_identity, true);
    },
  );
}

async function testResponsesStreamLifecycle(): Promise<void> {
  const rawBody = '{"model":"gpt-5-codex","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}],"stream":true,"store":false,"unknown_top":{"kept":true}}';
  const upstreamSse = [
    ": upstream keepalive\n\n",
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_upstream_123","status":"in_progress"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","response_id":"resp_upstream_123","delta":"ok"}\n\n',
    'event: vendor.unknown\ndata: {"opaque":true}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_upstream_123","status":"completed"}}\n\n',
  ].join("");

  await withFakeUpstream(
    (captured, res) => {
      assert.equal(captured.url, "/responses");
      sseResponse(res, upstreamSse);
    },
    async (baseUrl, captured) => {
      const carrier = createNativePassthroughCarrier({
        protocol: "openai_responses",
        body: JSON.parse(rawBody) as Record<string, unknown>,
        rawBody,
        headers: {
          authorization: "Bearer helm-client-key",
          "x-api-key": "client-upstream-key",
          "x-helm-internal": "drop-me",
          "user-agent": "codex-cli/0.1.0",
          "x-session-id": "sess-client",
          "openai-beta": "client-beta",
        },
      });
      const client = createCodexResponsesClient({
        config: {
          baseUrl,
          getAuthHeader: async () => `Bearer ${jwt("acct_passthrough")}`,
          timeoutMs: 2_000,
        },
      });

      const response = await collect(client.nativePassthroughStream?.(carrier) ?? []);
      assert.equal(response, upstreamSse);
      assert.equal(response.includes("helm"), false);
      assert.equal(response.includes("resp_upstream_123"), true);
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.rawBody.toString("utf8"), rawBody);
      const headers = lowerHeaders(captured[0]?.headers ?? {});
      assert.equal(headers.authorization?.startsWith("Bearer "), true);
      assert.equal(headers["x-api-key"], undefined);
      assert.equal(headers["x-helm-internal"], undefined);
      assert.equal(headers["x-session-id"], "sess-client");
      assert.equal(headers["openai-beta"], "client-beta, responses=experimental");
      assert.equal(carrier.mutations.auth_replaced, true);
      assert.equal(JSON.stringify(carrier.mutations).includes("helm-client-key"), false);
    },
  );
}

async function testResponsesExecuteStoreForcedFalse(): Promise<void> {
  const clientBody = {
    model: "codex/gpt-client-alias",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    store: true,
    future_field: { preserved: true },
  };
  const upstream = {
    id: "resp_store_false",
    object: "response",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  await withFakeUpstream(
    (_captured, res) => jsonResponse(res, upstream),
    async (baseUrl, captured) => {
      const carrier = createNativePassthroughCarrier({
        protocol: "openai_responses",
        body: clientBody,
        rawBody: JSON.stringify(clientBody),
        headers: {
          authorization: "Bearer client-key",
          "x-helm-internal": "drop",
          "x-session-id": "sess-client",
        },
      });
      const provider = createCodexResponsesClient({
        config: {
          baseUrl,
          getAuthHeader: async () => `Bearer ${jwt("acct_store")}`,
          timeoutMs: 2_000,
        },
      });
      const execute = executeWithProvider({
        alias: "r",
        providerName: "codex",
        providerModel: "gpt-5-codex",
        targetProviderProtocol: "openai_responses",
        provider,
      });

      const out = await execute(
        { selected_lane: "balanced", candidate_chain: ["r"], explicit_model: null },
        internalRequest({
          protocol: "openai_responses",
          native_request: carrier,
        }),
      );

      assert.equal(out.nativePassthrough, true);
      assert.equal(captured.length, 1);
      const parsed = captured[0]?.parsedBody as Record<string, unknown>;
      assert.equal(parsed.model, "gpt-5-codex");
      assert.equal(parsed.store, false);
      assert.deepEqual(parsed.future_field, { preserved: true });
      assert.deepEqual(carrier.mutations.body_shims_applied, [
        "instructions_defaulted",
        "store_forced_false",
      ]);
      assert.equal(carrier.mutations.model_rewritten?.to, "gpt-5-codex");
      const headers = lowerHeaders(captured[0]?.headers ?? {});
      assert.equal(headers["x-helm-internal"], undefined);
      assert.equal(headers["x-session-id"], "sess-client");
    },
  );
}

async function testResponsesExecuteStreamReframed(): Promise<void> {
  const rawBody =
    '{"model":"codex/gpt-client-alias","input":"hi","stream":true,"store":false,"unknown":1}';
  const upstreamSse =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","status":"completed"}}\n\n';

  await withFakeUpstream(
    (_captured, res) => sseResponse(res, upstreamSse),
    async (baseUrl, captured) => {
      const carrier = createNativePassthroughCarrier({
        protocol: "openai_responses",
        body: JSON.parse(rawBody) as Record<string, unknown>,
        rawBody,
        headers: { authorization: "Bearer client-key" },
      });
      const provider = createCodexResponsesClient({
        config: {
          baseUrl,
          getAuthHeader: async () => `Bearer ${jwt("acct_stream")}`,
          timeoutMs: 2_000,
        },
      });
      const execute = executeWithProvider({
        alias: "r",
        providerName: "codex",
        providerModel: "gpt-5-codex",
        targetProviderProtocol: "openai_responses",
        provider,
      });

      const out = await execute(
        { selected_lane: "balanced", candidate_chain: ["r"], explicit_model: null },
        internalRequest({
          protocol: "openai_responses",
          stream: true,
          native_request: carrier,
        }),
      );

      assert.equal(out.nativePassthrough, true);
      assert.equal(await collect(out.stream ?? []), upstreamSse);
      assert.equal(captured.length, 1);
      const parsed = captured[0]?.parsedBody as Record<string, unknown>;
      assert.equal(parsed.model, "gpt-5-codex");
      assert.equal(parsed.unknown, 1);
      assert.equal(carrier.mutations.stream_reframed, true);
    },
  );
}

async function testGovernanceDisabledPassthroughAvoidsUpstream(): Promise<void> {
  await withFakeUpstream(
    () => {
      throw new Error("upstream must not be called");
    },
    async (_baseUrl, captured) => {
      const provider: ProviderClient = {
        chatCompletion: async () => ({ id: "translated" }),
        chatCompletionStream: async function* () {
          yield 'event: translated\ndata: {}\n\n';
        },
        nativePassthrough: async () => {
          throw new Error("native passthrough should be disabled");
        },
        nativePassthroughStream: async function* () {
          throw new Error("native passthrough stream should be disabled");
        },
      };
      const execute = createExecute({
        defaultProvider: provider,
        providers: new Map([["codex", provider]]),
        registry: registry({
          alias: "r",
          providerName: "codex",
          providerModel: "gpt-5-codex",
          targetProviderProtocol: "openai_responses",
        }),
        breaker: createCircuitBreaker({ config: { failureThreshold: 5, cooldownMs: 1_000 } }),
        catalog: new Map(),
        now: () => 0,
        signal: new AbortController().signal,
        nativeProtocolPassthroughEnabled: () => false,
      });

      await execute(
        { selected_lane: "balanced", candidate_chain: ["r"], explicit_model: null },
        internalRequest({
          protocol: "openai_responses",
          native_request: createNativePassthroughCarrier({
            protocol: "openai_responses",
            body: { model: "codex/gpt-client-alias", input: "hi" },
            headers: {},
          }),
        }),
      ).catch(() => undefined);

      assert.equal(captured.length, 0);
    },
  );
}

async function testMessagesRouteNativeStreamPreservesRawSseFrames(): Promise<void> {
  const body = {
    model: "claude-client-alias",
    stream: true,
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
    future_field: { nested: true },
  };
  const upstreamSse = [
    ": upstream keepalive\n\n",
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_route_1"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
    ": upstream heartbeat\n\n",
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  let pipelineCalls = 0;
  let transformBackCalls = 0;
  let streamTransformCalls = 0;

  const deps: MessagesRouteDeps = {
    auth: { resolve: async (credential) => (credential === "route-key" ? { keyId: "k1", accountId: "acct" } : null) },
    transformers: {
      anthropic: {
        transformRequestOut: (native) => ({
          model: (native as { model?: string }).model,
          messages: (native as { messages?: unknown }).messages,
          stream: (native as { stream?: boolean }).stream,
          metadata: {},
        }),
        transformResponseOut: (ir) => {
          transformBackCalls += 1;
          return ir;
        },
        transformStreamOut: (event) => {
          streamTransformCalls += 1;
          return { event: String(event.type ?? "translated"), data: JSON.stringify(event) };
        },
        transformErrorOut: messagesErrorOut,
      },
    },
    pipeline: {
      run: async (ir) => {
        pipelineCalls += 1;
        const carrier = ir.metadata?.native_request as { protocol?: string; body?: unknown } | undefined;
        assert.equal(carrier?.protocol, "anthropic_messages");
        assert.deepEqual(carrier?.body, body);
        return {
          decision: ROUTE_DECISION,
          nativePassthrough: true,
          collect: async () => {
            throw new Error("streaming route must not collect");
          },
          streamIR: () => rawSseFrames(upstreamSse),
        };
      },
    },
  };
  const app = routeApp();
  registerMessagesRoute(app, deps);

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "route-key", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), upstreamSse);
  assert.equal(pipelineCalls, 1);
  assert.equal(transformBackCalls, 0);
  assert.equal(streamTransformCalls, 0);
}

async function testResponsesRouteNativeStreamPreservesRawSseFrames(): Promise<void> {
  const body = {
    model: "codex/gpt-client-alias",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
    future_field: { nested: true },
  };
  const upstreamSse = [
    ": upstream keepalive\n\n",
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_route_1","status":"in_progress"}}\n\n',
    'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_route_1","status":"in_progress"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","response_id":"resp_route_1","delta":"ok"}\n\n',
    ": upstream heartbeat\n\n",
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_route_1","status":"completed"}}\n\n',
  ].join("");
  let pipelineCalls = 0;
  let transformBackCalls = 0;
  let streamTransformCalls = 0;

  const deps: ResponsesRouteDeps = {
    auth: { resolve: async (credential) => (credential === "route-key" ? { keyId: "k1", accountId: "acct" } : null) },
    transformer: {
      transformRequestOut: (native) => ({
        model: (native as { model?: string }).model,
        messages: [{ role: "user", content: "hi" }],
        stream: (native as { stream?: boolean }).stream,
        metadata: {},
      }),
      transformResponseOut: (ir) => {
        transformBackCalls += 1;
        return ir;
      },
      transformStreamOut: (event) => {
        streamTransformCalls += 1;
        return { event: String(event.type ?? "translated"), data: JSON.stringify(event) };
      },
    },
    pipeline: {
      run: async (ir) => {
        pipelineCalls += 1;
        const carrier = ir.metadata?.native_request as { protocol?: string; body?: unknown } | undefined;
        assert.equal(carrier?.protocol, "openai_responses");
        assert.deepEqual(carrier?.body, body);
        return {
          decision: ROUTE_DECISION,
          nativePassthrough: true,
          collect: async () => {
            throw new Error("streaming route must not collect");
          },
          streamIR: () => rawSseFrames(upstreamSse),
        };
      },
    },
  };
  const app = routeApp();
  registerResponsesRoute(app, deps);

  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer route-key", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), upstreamSse);
  assert.equal(pipelineCalls, 1);
  assert.equal(transformBackCalls, 0);
  assert.equal(streamTransformCalls, 0);
}

async function testMessagesRouteGovernanceRejectAvoidsPipelineForwarding(): Promise<void> {
  let transformCalls = 0;
  let pipelineCalls = 0;
  const app = routeApp();
  registerMessagesRoute(app, {
    rateLimiter: routeRejectLimiter(),
    auth: { resolve: async () => ({ keyId: "k1", accountId: "acct" }) },
    transformers: {
      anthropic: {
        transformRequestOut: () => {
          transformCalls += 1;
          return { model: "m", messages: [{ role: "user", content: "hi" }], stream: true, metadata: {} };
        },
        transformResponseOut: (ir) => ir,
        transformStreamOut: (event) => ({ event: String(event.type ?? "translated"), data: JSON.stringify(event) }),
        transformErrorOut: messagesErrorOut,
      },
    },
    pipeline: {
      run: async () => {
        pipelineCalls += 1;
        throw new Error("governance reject must not reach the pipeline");
      },
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "route-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude", stream: true, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
  });

  assert.equal(res.status, 429);
  assert.equal(transformCalls, 0);
  assert.equal(pipelineCalls, 0);
}

async function testResponsesRouteGovernanceRejectAvoidsPipelineForwarding(): Promise<void> {
  let transformCalls = 0;
  let pipelineCalls = 0;
  const app = routeApp();
  registerResponsesRoute(app, {
    rateLimiter: routeRejectLimiter(),
    auth: { resolve: async () => ({ keyId: "k1", accountId: "acct" }) },
    transformer: {
      transformRequestOut: () => {
        transformCalls += 1;
        return { model: "m", messages: [{ role: "user", content: "hi" }], stream: true, metadata: {} };
      },
      transformResponseOut: (ir) => ir,
      transformStreamOut: (event) => ({ event: String(event.type ?? "translated"), data: JSON.stringify(event) }),
    },
    pipeline: {
      run: async () => {
        pipelineCalls += 1;
        throw new Error("governance reject must not reach the pipeline");
      },
    },
  });

  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer route-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt", input: "hi", stream: true, store: false }),
  });

  assert.equal(res.status, 429);
  assert.equal(transformCalls, 0);
  assert.equal(pipelineCalls, 0);
}

async function main(): Promise<void> {
  const tests = [
    testAnthropicNonStream,
    testAnthropicExecuteModelRewrite,
    testAnthropicStreamSafetyHeaders,
    testResponsesStreamLifecycle,
    testResponsesExecuteStoreForcedFalse,
    testResponsesExecuteStreamReframed,
    testGovernanceDisabledPassthroughAvoidsUpstream,
    testMessagesRouteNativeStreamPreservesRawSseFrames,
    testResponsesRouteNativeStreamPreservesRawSseFrames,
    testMessagesRouteGovernanceRejectAvoidsPipelineForwarding,
    testResponsesRouteGovernanceRejectAvoidsPipelineForwarding,
  ];
  let failures = 0;
  for (const test of tests) {
    try {
      await test();
      console.log(`ok - ${test.name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${test.name}`);
      console.error(error);
    }
  }
  if (failures > 0) throw new Error(`passthrough deterministic e2e failed (${failures} cases)`);
  console.log(`ok - passthrough deterministic e2e (${tests.length} cases)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
