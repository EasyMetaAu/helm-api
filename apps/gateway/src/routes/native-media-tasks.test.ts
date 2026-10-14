import type { ResponsesRegistryRecord } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const Created = z.object({ request_id: z.string(), status: z.string() });
const Failed = z.object({ error: z.object({ code: z.string(), operation_id: z.string() }) });

import type { AppEnv } from "../app.js";
import type { NativeMediaTaskProfile } from "./native-media-tasks.js";
import { registerMediaTaskRoutes, type VideoCreateTarget, type VideosRouteDeps } from "./videos.js";

const fingerprint = "a".repeat(64);
function setup(kind: "video" | "transcription" = "video") {
  let now = 1000;
  let key = "key-a";
  let currentFingerprint = fingerprint;
  const records = new Map<string, ResponsesRegistryRecord>();
  const create = vi.fn(async () => ({ id: "upstream-1" }));
  const retrieve = vi.fn(async () => ({ id: "upstream-1", status: "done" }));
  const profile: NativeMediaTaskProfile = {
    profile: "bailian",
    endpointIdentity: fingerprint,
    queryTtlMs: 86400000,
    validate: (body) => {
      if (!body.prompt) throw new Error("prompt required");
      return body;
    },
    parseCreated: (body) => (typeof body.id === "string" ? body.id : null),
    normalize: (body, id) =>
      body.id === id
        ? {
            status: "done",
            ...(kind === "video"
              ? { video: { url: "https://cdn.example/video.mp4" } }
              : { transcription: { results: [{ text: "hello" }] } }),
          }
        : null,
  };
  const target: VideoCreateTarget = {
    nativeTask: profile,
    providerAlias: "bailian/video",
    providerName: "bailian",
    providerModel: "wan3.0-video",
    providerAccount: "account-a",
    laneName: "video-standard",
    client: { create },
  };
  const put = vi.fn(async (r: ResponsesRegistryRecord) => {
    records.set(r.responseId, r);
  });
  const deps: VideosRouteDeps = {
    auth: { resolve: async () => ({ accountId: "owner", keyId: key }) },
    resolver: {
      create: async () => target,
      poll: async () => ({
        nativeTask: { ...profile, endpointIdentity: currentFingerprint },
        retrieve,
      }),
    },
    registry: {
      get: async (id) => records.get(id) ?? null,
      put,
      putIfAbsent: async (r) => {
        if (records.has(r.responseId)) return false;
        await put(r);
        return true;
      },
    },
    now: () => now,
  };
  const app = new Hono<AppEnv>();
  registerMediaTaskRoutes(app, deps, kind);
  const root = kind === "video" ? "/v1/videos" : "/v1/audio/transcription-jobs";
  const post = () =>
    app.request(root + (kind === "video" ? "/generations" : ""), {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ model: "video-standard", prompt: "hello" }),
    });
  return {
    app,
    deps,
    root,
    records,
    create,
    retrieve,
    profile,
    target,
    post,
    setKey: (v: string) => {
      key = v;
    },
    setTime: (v: number) => {
      now = v;
    },
    setFingerprint: (v: string) => {
      currentFingerprint = v;
    },
    put,
  };
}
describe("native media task route", () => {
  it.each([
    "video",
    "transcription",
  ] as const)("creates and retrieves %s with a private upstream ID", async (kind) => {
    const t = setup(kind);
    const response = await t.post();
    expect(response.status).toBe(200);
    const result = Created.parse(await response.json());
    expect(result.request_id).not.toBe("upstream-1");
    expect(result.status).toBe("queued");
    const poll = await t.app.request(`${t.root}/${result.request_id}`);
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ request_id: result.request_id, status: "done" });
    expect(t.retrieve).toHaveBeenCalledWith("upstream-1", expect.any(AbortSignal));
    expect(t.create).toHaveBeenCalledTimes(1);
  });
  it("denies other keys without querying the provider", async () => {
    const t = setup();
    const r = Created.parse(await (await t.post()).json());
    t.setKey("other");
    expect((await t.app.request(`${t.root}/${r.request_id}`)).status).toBe(404);
    expect(t.retrieve).not.toHaveBeenCalled();
  });
  it("denies changed endpoint or credential generation without querying", async () => {
    const t = setup();
    const r = Created.parse(await (await t.post()).json());
    t.setFingerprint("b".repeat(64));
    expect((await t.app.request(`${t.root}/${r.request_id}`)).status).toBe(409);
    expect(t.retrieve).not.toHaveBeenCalled();
  });
  it("expires querying separately from the durable record", async () => {
    const t = setup();
    const r = Created.parse(await (await t.post()).json());
    t.setTime(86401000);
    expect((await t.app.request(`${t.root}/${r.request_id}`)).status).toBe(410);
    expect(t.records.has(`video:${r.request_id}`)).toBe(true);
    expect(t.retrieve).not.toHaveBeenCalled();
  });
  it("returns a durable operation ID and never retries an unknown create", async () => {
    const t = setup();
    t.create.mockRejectedValueOnce(new Error("response lost"));
    const response = await t.post();
    expect(response.status).toBe(503);
    const r = Failed.parse(await response.json());
    expect(r.error.code).toBe("outcome_unknown");
    expect(r.error.operation_id).toBeTruthy();
    expect(t.records.has(`video-create:${r.error.operation_id}`)).toBe(true);
    expect(t.create).toHaveBeenCalledTimes(1);
    const operation = await t.app.request(`${t.root}/operations/${r.error.operation_id}`);
    expect(operation.status).toBe(200);
    expect(await operation.json()).toMatchObject({
      operation_id: r.error.operation_id,
      state: "outcome_unknown",
    });
    t.setKey("other");
    expect((await t.app.request(`${t.root}/operations/${r.error.operation_id}`)).status).toBe(404);
  });
  it("does not send on failed durable reservation", async () => {
    const t = setup();
    t.put.mockRejectedValueOnce(new Error("store down"));
    expect((await t.post()).status).toBe(503);
    expect(t.create).not.toHaveBeenCalled();
  });
  it("never retries after upstream accepted but task binding failed", async () => {
    const t = setup();
    let writes = 0;
    t.put.mockImplementation(async (r) => {
      writes++;
      if (r.responseId.startsWith("video:")) throw new Error("disk");
      t.records.set(r.responseId, r);
    });
    const response = await t.post();
    expect(response.status).toBe(503);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(writes).toBeGreaterThan(1);
    expect(JSON.stringify([...t.records.values()])).toContain("upstream-1");
  });
});
