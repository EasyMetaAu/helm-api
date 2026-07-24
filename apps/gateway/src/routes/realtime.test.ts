import type { ProviderClient, RealtimeCallResult } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { createRealtimeCallRegistry } from "../realtime-call-registry.js";
import { registerRealtimeRoutes } from "./realtime.js";

function multipart(session: Record<string, unknown>): FormData {
  const body = new FormData();
  body.set("sdp", new Blob(["v=offer\r\n"], { type: "application/sdp" }), "sdp");
  body.set(
    "session",
    new Blob([JSON.stringify(session)], { type: "application/json" }),
    "session.json",
  );
  return body;
}

function setup(blockedModels: string[] = []) {
  const sideband = {
    url: "wss://upstream.test/v1/realtime?call_id=rtc_1",
    headers: async () => ({ Authorization: "Bearer upstream" }),
  };
  const realtimeCall = vi.fn().mockResolvedValue({
    status: 201,
    sdp: "v=answer\r\n",
    contentType: "application/sdp",
    location: "/v1/realtime/calls/rtc_1",
    callId: "rtc_1",
    sideband,
  } satisfies RealtimeCallResult);
  const client = { realtimeCall } as unknown as ProviderClient;
  const registry = createRealtimeCallRegistry();
  const app = new Hono<AppEnv>();
  registerRealtimeRoutes(app, {
    auth: {
      resolve: async (credential) =>
        credential === "helm-key" ? { keyId: "key-1", blockedModels } : null,
    },
    resolve: (model) =>
      model === "gpt-realtime-1.5"
        ? { client, providerModel: model, alias: `openai-codex/${model}` }
        : model === "gpt-live-1-boulder-alpha"
          ? { client, providerModel: model, alias: `openai-codex/${model}` }
          : null,
    registry,
  });
  return { app, realtimeCall, registry, sideband };
}

describe("registerRealtimeRoutes", () => {
  it("creates a V1/V2 call, forwards allowed metadata, and binds its sideband", async () => {
    const { app, realtimeCall, registry, sideband } = setup();
    const response = await app.request("/v1/realtime/calls?intent=quicksilver&architecture=avas", {
      method: "POST",
      headers: {
        Authorization: "Bearer helm-key",
        "openai-alpha": "quicksilver=v1",
        "session-id": "sess-1",
        "x-secret": "do-not-forward",
      },
      body: multipart({ model: "gpt-realtime-1.5", type: "quicksilver" }),
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("v=answer\r\n");
    expect(response.headers.get("location")).toBe("/v1/realtime/calls/rtc_1");
    expect(realtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "realtime",
        query: "intent=quicksilver&architecture=avas",
        sdp: "v=offer\r\n",
        session: expect.objectContaining({ model: "gpt-realtime-1.5" }),
        headers: {
          "openai-alpha": "quicksilver=v1",
          "session-id": "sess-1",
        },
      }),
      expect.anything(),
    );
    expect(registry.take("rtc_1", "key-1")).toEqual({ ok: true, target: sideband });
  });

  it("maps the Frameless endpoint and rewrites only the provider model", async () => {
    const { app, realtimeCall } = setup();
    const response = await app.request("/v1/live", {
      method: "POST",
      headers: { Authorization: "Bearer helm-key", "openai-alpha": "quicksilver=v2" },
      body: multipart({
        model: "gpt-live-1-boulder-alpha",
        delegation: { type: "client" },
      }),
    });

    expect(response.status).toBe(201);
    expect(realtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "live", query: "" }),
      expect.anything(),
    );
  });

  it("rejects an invalid Helm key before calling upstream", async () => {
    const { app, realtimeCall } = setup();
    const response = await app.request("/v1/realtime/calls", {
      method: "POST",
      body: multipart({ model: "gpt-realtime-1.5" }),
    });
    expect(response.status).toBe(401);
    expect(realtimeCall).not.toHaveBeenCalled();
  });

  it("enforces blocked_models against the resolved provider alias", async () => {
    const { app, realtimeCall } = setup(["openai-codex/*"]);
    const response = await app.request("/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: "Bearer helm-key" },
      body: multipart({ model: "gpt-realtime-1.5" }),
    });
    expect(response.status).toBe(400);
    expect(realtimeCall).not.toHaveBeenCalled();
  });
});
