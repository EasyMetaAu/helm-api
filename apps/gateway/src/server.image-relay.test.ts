import type { CircuitBreaker } from "@helm/core";
import { ProviderConfigSchema } from "@helm/shared";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { AppEnv } from "./app.js";
import { registerImagesRoute } from "./routes/images.js";
import { buildProviderClients, buildServer } from "./server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("rejects invalid image controller configuration before opening the server store", async () => {
  vi.stubEnv("HELM_CODEX_IMAGE_CONTROLLER_MODEL", "bad model");
  await expect(buildServer({ configDir: "/missing-image-test-config" })).rejects.toThrow(
    /Invalid string/,
  );
});

function setup(type: "helm" | "openai", upstreamStatus = 200, code = "client_not_allowed") {
  vi.stubEnv("IMAGE_RELAY_KEY", "upstream-key");
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    await Promise.resolve();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer upstream-key");
    return Response.json(
      upstreamStatus === 200
        ? { data: [{ b64_json: "IMAGE" }] }
        : { error: { code, message: "private upstream detail" } },
      { status: upstreamStatus },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const provider = ProviderConfigSchema.parse({
    name: "image-relay",
    type,
    base_url: "https://upstream.test/v1",
    api_key_env: "IMAGE_RELAY_KEY",
    models: [{ alias: "image-relay/image", provider_model: "gpt-image" }],
  });
  const client = buildProviderClients([provider], "https://api.openai.com/v1", 1000).get(
    provider.name,
  );
  if (!client) throw new Error("missing test provider");
  const breaker = {
    canAttempt: () => ({ allow: true, probe: false }),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordAbort: vi.fn(),
  } as unknown as CircuitBreaker;
  const app = new Hono<AppEnv>();
  registerImagesRoute(app, {
    auth: { resolve: async () => ({ keyId: "key", accountId: "account" }) },
    resolveImageChain: () => ({
      ok: true,
      laneName: "gpt-image",
      candidateChain: ["image-relay/image", "image-relay/fallback"],
      targets: ["image-relay/image", "image-relay/fallback"].map((alias) => ({
        alias,
        providerModel: "gpt-image",
        kind: "openai",
        client,
      })),
    }),
    breaker,
    costOf: () => null,
  });
  return { app, fetch, breaker };
}

function request(app: Hono<AppEnv>, kind: "json" | "multipart" | "generation", ua?: string) {
  const headers = new Headers({ authorization: "Bearer inbound-key" });
  if (ua) headers.set("user-agent", ua);
  let body: string | FormData;
  if (kind === "multipart") {
    body = new FormData();
    body.set("model", "gpt-image");
    body.set("prompt", "make the circle blue");
    body.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "input.png");
  } else {
    headers.set("content-type", "application/json");
    body = JSON.stringify({
      model: "gpt-image",
      prompt: "make the circle blue",
      ...(kind === "json" ? { images: [{ image_url: "data:image/png;base64,AQID" }] } : {}),
    });
  }
  return app.request(`/v1/images/${kind === "generation" ? "generations" : "edits"}`, {
    method: "POST",
    headers,
    body,
  });
}

it.each([
  "json",
  "multipart",
  "generation",
] as const)("preserves each Helm image %s request's client identity without changing upstream auth", async (kind) => {
  const { app, fetch } = setup("helm");
  const identities = ["codex_cli_rs/0.162.1", "Claude/1.0.0"];
  const responses = await Promise.all(identities.map((ua) => request(app, kind, ua)));
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect(fetch.mock.calls.map(([, init]) => new Headers(init.headers).get("user-agent"))).toEqual(
    identities,
  );
  await request(app, kind);
  expect(new Headers(fetch.mock.calls[2]?.[1].headers).get("user-agent")).toBeNull();
});

it("does not forward the downstream client identity to a third-party image provider", async () => {
  const { app, fetch } = setup("openai");
  expect((await request(app, "json", "codex_cli_rs/0.162.1")).status).toBe(200);
  expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("user-agent")).toBeNull();
});

it.each([
  [403, "client_not_allowed"],
  [404, "model_not_found"],
] as const)("returns an explicit upstream %s rejection without marking it outcome_unknown", async (status, code) => {
  const { app, fetch, breaker } = setup("helm", status, code);
  const response = await request(app, "multipart", "codex_cli_rs/0.162.1");
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body).toMatchObject({ error: { code } });
  expect(JSON.stringify(body)).not.toContain("private upstream detail");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(breaker.recordFailure).not.toHaveBeenCalled();
});
