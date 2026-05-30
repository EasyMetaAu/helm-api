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

// Build an app: trace/log middleware (from createApp) + auth + chat route.
function buildApp(deps: ChatRouteDeps, opts: { authed?: boolean } = { authed: true }) {
  const app = createApp({ logger: { log: () => {} } });
  const getByHash = vi.fn().mockResolvedValue(opts.authed === false ? null : keyRecord());
  app.use("/v1/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerChatRoutes(app, deps);
  return { app, getByHash };
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

const BODY = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: false };
const AUTH = { Authorization: "Bearer helm_live_secret", "Content-Type": "application/json" };

describe("POST /v1/chat/completions (non-streaming passthrough)", () => {
  it("passes through the upstream response unchanged", async () => {
    const upstream = { id: "cmpl-1", choices: [{ message: { content: "hello" } }] };
    const d = deps();
    (d.provider.chatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(upstream);
    const { app } = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream);
  });

  it("forwards the request body verbatim to the provider", async () => {
    const d = deps();
    (d.provider.chatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const { app } = buildApp(d);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    const arg = (d.provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(arg).toEqual(BODY);
  });

  it("persists one redacted telemetry record with identity + latency", async () => {
    const d = deps();
    (d.provider.chatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const { app } = buildApp(d);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    expect(d.telemetry.insert).toHaveBeenCalledOnce();
    expect(d.redact).toHaveBeenCalled();
    const insertArg = (d.telemetry.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(insertArg.apiKeyId).toBe("k1");
    expect(insertArg.decision.provider_attempts[0].latency_ms).toBeGreaterThan(0);
    expect(JSON.stringify(insertArg)).not.toContain("helm_live_secret");
  });

  it("maps a provider upstream error to a 502 OpenAI-shaped error + error telemetry", async () => {
    const d = deps();
    (d.provider.chatCompletion as ReturnType<typeof vi.fn>).mockRejectedValue(
      new UpstreamError("upstream_error", "boom"),
    );
    const { app } = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.trace_id).toBeTruthy();
    const insertArg = (d.telemetry.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(insertArg.decision.final.status).toBe("error");
  });

  it("maps a timeout to 504 with error_class timeout in telemetry", async () => {
    const d = deps();
    (d.provider.chatCompletion as ReturnType<typeof vi.fn>).mockRejectedValue(
      new UpstreamError("timeout", "slow"),
    );
    const { app } = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(504);
    const insertArg = (d.telemetry.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(insertArg.decision.provider_attempts[0].error_class).toBe("timeout");
  });

  it("rejects unauthenticated requests without calling the provider", async () => {
    const d = deps();
    const { app } = buildApp(d, { authed: false });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(401);
    expect(d.provider.chatCompletion).not.toHaveBeenCalled();
  });

  it("fails open: a telemetry failure does not break a successful response", async () => {
    const d = deps({
      telemetry: {
        insert: vi.fn().mockRejectedValue(new Error("db down")),
      } as unknown as TelemetryStore,
    });
    (d.provider.chatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const { app } = buildApp(d);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
