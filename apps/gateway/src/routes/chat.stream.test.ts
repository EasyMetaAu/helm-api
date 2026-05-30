import type { ApiKeyRecord, ProviderClient, TelemetryStore } from "@helm/core";
import { hashKey, UpstreamError } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ChatRouteDeps, registerChatRoutes } from "./chat.js";

function keyRecord(): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    max_lane: null,
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
  };
}

function buildApp(deps: ChatRouteDeps, opts: { authed?: boolean } = { authed: true }) {
  const app = createApp({ logger: { log: () => {} } });
  const getByHash = vi.fn().mockResolvedValue(opts.authed === false ? null : keyRecord());
  app.use("/v1/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerChatRoutes(app, deps);
  return { app };
}

async function* gen(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

function deps(over: Partial<ChatRouteDeps> = {}): ChatRouteDeps {
  let t = 1000;
  return {
    provider: {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient,
    telemetry: { insert: vi.fn().mockResolvedValue({ id: "1" }) } as unknown as TelemetryStore,
    redact: vi.fn((x) => x),
    now: () => (t += 50),
    ...over,
  };
}

const STREAM_BODY = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};
const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

function lastInsert(d: ChatRouteDeps) {
  const calls = (d.telemetry.insert as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("POST /v1/chat/completions (streaming SSE passthrough)", () => {
  it("forwards upstream SSE chunks verbatim", async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"];
    const d = deps();
    (d.provider.chatCompletionStream as ReturnType<typeof vi.fn>).mockReturnValue(gen(chunks));
    const { app } = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const ch of chunks) {
      expect(text).toContain(ch.trim());
    }
  });

  it("uses the streaming method and forwards the body verbatim", async () => {
    const d = deps();
    (d.provider.chatCompletionStream as ReturnType<typeof vi.fn>).mockReturnValue(
      gen(["data: [DONE]\n\n"]),
    );
    const { app } = buildApp(d);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });
    expect(d.provider.chatCompletion).not.toHaveBeenCalled();
    const arg = (d.provider.chatCompletionStream as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(arg).toEqual(STREAM_BODY);
  });

  it("records a client disconnect as client_abort, not a provider fault", async () => {
    const d = deps();
    async function* aborting(): AsyncGenerator<string> {
      yield 'data: {"a":1}\n\n';
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    (d.provider.chatCompletionStream as ReturnType<typeof vi.fn>).mockReturnValue(aborting());
    const { app } = buildApp(d);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });
    const rec = lastInsert(d);
    expect(rec.decision.provider_attempts[0].error_class).toBe("client_abort");
    expect(rec.decision.provider_attempts[0].error_class).not.toBe("upstream_error");
  });

  it("records an upstream stream failure as upstream_error and emits an error SSE frame", async () => {
    const d = deps();
    async function* failing(): AsyncGenerator<string> {
      yield 'data: {"a":1}\n\n';
      throw new UpstreamError("upstream_error", "boom");
    }
    (d.provider.chatCompletionStream as ReturnType<typeof vi.fn>).mockReturnValue(failing());
    const { app } = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });
    const text = await res.text();
    expect(text).toContain("error");
    expect(text).toContain("upstream_error");
    const rec = lastInsert(d);
    expect(rec.decision.final.status).toBe("error");
    expect(rec.decision.provider_attempts[0].error_class).toBe("upstream_error");
  });

  it("persists a redacted stream telemetry record with identity + latency", async () => {
    const d = deps();
    (d.provider.chatCompletionStream as ReturnType<typeof vi.fn>).mockReturnValue(
      gen(["data: [DONE]\n\n"]),
    );
    const { app } = buildApp(d);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(STREAM_BODY),
    });
    expect(d.redact).toHaveBeenCalled();
    const rec = lastInsert(d);
    expect(rec.apiKeyId).toBe("k1");
    expect(rec.decision.provider_attempts[0].latency_ms).toBeGreaterThan(0);
    expect(JSON.stringify(rec)).not.toContain("helm_live_secret");
  });

  it("rejects unauthenticated stream requests without opening a stream", async () => {
    const d = deps();
    const { app } = buildApp(d, { authed: false });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: JSON.stringify(STREAM_BODY),
    });
    expect(res.status).toBe(401);
    expect(d.provider.chatCompletionStream).not.toHaveBeenCalled();
  });
});
