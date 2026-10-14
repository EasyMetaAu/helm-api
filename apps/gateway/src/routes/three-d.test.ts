type ArkPublicTestBody = {
  request_id: string;
  status: string;
  video?: unknown;
  file?: unknown;
  error: { code: string };
};

import type { ResponsesRegistryRecord, ResponsesRegistryStore } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { createResponsesRegistry } from "../responses-registry.js";
import type { MessagesIdentity } from "./messages.js";
import type { RecordServedDeps } from "./payload-capture.js";
import { registerThreeDRoute, type ThreeDRouteDeps } from "./three-d.js";
import { registerVideosRoute } from "./videos.js";

const model = "doubao-seed3d-2-0-260328";
const owner: MessagesIdentity = {
  keyId: "key-one",
  accountId: "owner-one",
  caps: { allowCustomModel: true },
};
const body = (name = "seed3d") => ({
  model: name,
  content: [{ type: "image_url", image_url: { url: "https://input.example.test/object.png" } }],
  file_format: "glb",
  subdivision_level: "high",
});
function setup() {
  let now = 1000000;
  const rows = new Map<string, ResponsesRegistryRecord>();
  const create = vi.fn().mockResolvedValue({ id: "task-3d" });
  const retrieve = vi.fn().mockResolvedValue({
    id: "task-3d",
    model,
    status: "succeeded",
    updated_at: now / 1000,
    content: { file_url: "https://output.example.test/object.zip" },
    fileformat: "glb",
    subdivisionlevel: "high",
    error: null,
    usage: null,
  });
  const store: ResponsesRegistryStore = {
    upsert: async (row) => {
      rows.set(row.responseId, structuredClone(row));
    },
    insertIfAbsent: async (row) => {
      if (rows.has(row.responseId)) return false;
      rows.set(row.responseId, structuredClone(row));
      return true;
    },
    getOwnedLive: async (input) => {
      const row = rows.get(input.responseId);
      return row &&
        row.accountId === input.accountId &&
        row.keyId === input.keyId &&
        row.expiresAt > input.nowMs
        ? structuredClone(row)
        : null;
    },
    prune: async () => {},
  };
  const enqueueTelemetry = vi.fn();
  const record = {
    telemetry: { insert: vi.fn() },
    redact: (value: unknown) => value,
    now: () => now,
    capturePayloads: () => false,
    writes: { enqueueTelemetry, enqueuePayload: vi.fn() },
  } as unknown as RecordServedDeps;
  const resolver: ThreeDRouteDeps["resolver"] = {
    create: async (body) => ({
      providerType: "ark",
      laneName: body.model === "seed3d" ? "seed3d" : undefined,
      providerAlias: "ark/seed3d-2.0",
      providerName: "ark-3d",
      providerModel: model,
      providerAccount: null,
      client: { create },
    }),
    poll: async () => ({ providerType: "ark", providerModel: model, retrieve }),
  };
  const restart = (over: Partial<ThreeDRouteDeps> = {}) => {
    const app = new Hono<AppEnv>();
    const deps: ThreeDRouteDeps = {
      auth: { resolve: async (key) => (key === "k" ? owner : null) },
      registry: createResponsesRegistry(store, undefined, { now: () => now }),
      resolver,
      now: () => now,
      record,
      ...over,
    };
    registerThreeDRoute(app, deps);
    registerVideosRoute(app, deps);
    return app;
  };
  return {
    app: restart(),
    restart,
    create,
    retrieve,
    rows,
    enqueueTelemetry,
    setNow: (time: number) => {
      now = time;
    },
  };
}
const post = (app: Hono<AppEnv>, data: Record<string, unknown> = body()) =>
  app.request("/v1/3d/generations", {
    method: "POST",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
const poll = (app: Hono<AppEnv>, id: string) =>
  app.request(`/v1/3d/${id}`, { headers: { Authorization: "Bearer k" } });

describe("Ark 3D task route", () => {
  it.each([
    "seed3d",
    "ark/seed3d-2.0",
    model,
  ])("creates %s once and returns a ZIP containing GLB after registry recreation", async (name) => {
    const { app, restart, create, retrieve, rows } = setup();
    const response = await post(app, body(name));
    expect(response.status).toBe(200);
    const { request_id } = (await response.json()) as ArkPublicTestBody;
    expect(request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toEqual(body(model));
    const result = await poll(restart(), request_id);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      request_id,
      status: "done",
      file: { url: "https://output.example.test/object.zip", format: "zip", model_format: "glb" },
    });
    expect(retrieve).toHaveBeenCalledWith("task-3d", expect.any(AbortSignal));
    expect(rows.get(`three-d:${request_id}`)?.selectedLane).toBe("three-d");
  });
  it("records a 3D decision, never a video decision", async () => {
    const { app, enqueueTelemetry } = setup();
    expect((await post(app)).status).toBe(200);
    expect(JSON.stringify(enqueueTelemetry.mock.calls)).toContain('"selected_lane":"three-d"');
    expect(JSON.stringify(enqueueTelemetry.mock.calls)).toContain('"reason":"three_d_generation"');
  });
  it("cannot read a 3D task through the video endpoint or another owner", async () => {
    const { app, restart, retrieve } = setup();
    const { request_id } = (await (await post(app)).json()) as ArkPublicTestBody;
    expect(
      (await app.request(`/v1/videos/${request_id}`, { headers: { Authorization: "Bearer k" } }))
        .status,
    ).toBe(404);
    expect(
      (
        await poll(
          restart({ auth: { resolve: async () => ({ ...owner, keyId: "other" }) } }),
          request_id,
        )
      ).status,
    ).toBe(404);
    expect(retrieve).not.toHaveBeenCalled();
  });
  it.each([
    { content: [] },
    { content: [...body().content, ...body().content] },
    { file_format: "obj" },
    { subdivision_level: "invalid" },
  ])("rejects malformed 3D input before creation: %j", async (changes) => {
    const { app, create } = setup();
    expect((await post(app, { ...body(), ...changes })).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects spend-capped or blocked keys without reservation/creation", async () => {
    const { restart, create, rows } = setup();
    for (const caps of [{ budget: { spendUsd: 1 } }, { blockedModels: [model] }]) {
      const response = await post(
        restart({ auth: { resolve: async () => ({ ...owner, caps }) as MessagesIdentity } }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(create).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });
  it("fails closed for mismatched model/id, unknown state and missing artifacts", async () => {
    const { app, retrieve } = setup();
    const { request_id } = (await (await post(app)).json()) as ArkPublicTestBody;
    for (const value of [
      { id: "wrong", model, status: "queued" },
      { id: "task-3d", model: "wrong", status: "queued" },
      { id: "task-3d", model, status: "new_state" },
      { id: "task-3d", model, status: "succeeded", content: null },
    ]) {
      retrieve.mockResolvedValue(value);
      expect((await poll(app, request_id)).status).toBe(502);
    }
  });
  it.each([
    "failed",
    "cancelled",
    "expired",
  ])("handles %s and nullable content/usage safely", async (status) => {
    const { app, retrieve } = setup();
    const { request_id } = (await (await post(app)).json()) as ArkPublicTestBody;
    retrieve.mockResolvedValue({
      id: "task-3d",
      model,
      status,
      content: null,
      usage: null,
      error:
        status === "failed"
          ? { code: "SetLimitExceeded", message: "secret provider credential" }
          : null,
    });
    const result = await poll(app, request_id);
    expect(result.status).toBe(200);
    const data = (await result.json()) as ArkPublicTestBody;
    expect(data.status).toBe(status);
    expect(JSON.stringify(data)).not.toContain("secret provider credential");
    expect(data.file).toBeUndefined();
  });
  it("does not expose stale ZIP URLs and expires task ownership after seven days", async () => {
    const { app, setNow, retrieve } = setup();
    const { request_id } = (await (await post(app)).json()) as ArkPublicTestBody;
    setNow(1000000 + 86400000);
    expect(await (await poll(app, request_id)).json()).toMatchObject({ status: "expired" });
    setNow(1000000 + 7 * 86400000);
    expect((await poll(app, request_id)).status).toBe(404);
    expect(retrieve).toHaveBeenCalledOnce();
  });
  it("does not repeat an ambiguous paid create or settle a second poll request", async () => {
    const { app, create } = setup();
    create.mockRejectedValue(new Error("upstream disconnected"));
    expect(await (await post(app)).json()).toMatchObject({ error: { code: "outcome_unknown" } });
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("3D permission and accounting boundaries", () => {
  it("enforces authentication and client policy before any create", async () => {
    const { app, restart, create } = setup();
    expect(
      (await app.request("/v1/3d/generations", { method: "POST", body: JSON.stringify(body()) }))
        .status,
    ).toBe(401);
    const denied = restart({
      auth: {
        resolve: async () =>
          ({
            ...owner,
            caps: { clientPolicy: { allowed_clients: ["codex_cli"] } },
          }) as MessagesIdentity,
      },
    });
    expect((await post(denied)).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
  it("enforces lane and direct model permissions", async () => {
    const { restart, create } = setup();
    const restricted = restart({
      auth: {
        resolve: async () =>
          ({ ...owner, caps: { allowedLanes: [], allowCustomModel: false } }) as MessagesIdentity,
      },
    });
    expect((await post(restricted)).status).toBe(403);
    for (const name of ["ark/seed3d-2.0", model])
      expect((await post(restricted, body(name))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it("does not create on concurrency denial", async () => {
    const { restart, create } = setup();
    const app = restart({
      concurrencyGate: {
        acquire: async () => ({
          ok: false as const,
          reason: "unavailable" as const,
          retryAfterSeconds: 1,
        }),
      },
    });
    expect((await post(app)).status).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });
  it("settles only one request with unknown cost and never settles polling", async () => {
    const { restart } = setup();
    const settleBudget = vi.fn();
    const app = restart({
      auth: {
        resolve: async () =>
          ({ ...owner, caps: { budget: { spendUsd: null, requests: 10 } } }) as MessagesIdentity,
      },
      settleBudget,
    });
    const data = (await (await post(app)).json()) as ArkPublicTestBody;
    expect(data.request_id).toBeTypeOf("string");
    await poll(app, data.request_id);
    await poll(app, data.request_id);
    expect(settleBudget).toHaveBeenCalledTimes(1);
    expect(settleBudget.mock.calls[0]?.[2]).toEqual({ requests: 1, tokens: 0, costUsd: null });
  });
});
