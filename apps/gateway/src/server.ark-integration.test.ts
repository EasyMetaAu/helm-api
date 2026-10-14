import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CreateKeyInput, createSqliteDb, hashKey, SqliteKeyStore } from "@helm/core";
import { expect, it, vi } from "vitest";
import { buildServer, type ServerHandle } from "./server.js";

it("routes four Ark models through SDK, enforces key boundaries and restores owned tasks after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helm-ark-integration-"));
  const db = createSqliteDb(join(dir, "helm.db"));
  let server: ServerHandle | undefined;
  const tasks = new Map<string, string>();
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const headers = (key = "owner") => ({
    Authorization: `Bearer test-${key}`,
    "content-type": "application/json",
  });
  const video = {
    model: "seedance-video",
    content: [{ type: "text", text: "A red apple" }],
    duration: 4,
    resolution: "480p",
  };
  const threeD = {
    model: "seed3d",
    content: [{ type: "image_url", image_url: { url: "https://example.com/apple.png" } }],
  };
  try {
    await cp(resolve("config"), join(dir, "config"), { recursive: true });
    for (const [keyId, extra] of [
      ["owner", { allowCustomModel: true }],
      ["other", { allowCustomModel: true }],
      ["spend", { budgetSpendUsd: 1, budgetWindowSeconds: 3600 }],
      ["blocked", { blockedModels: ["ark/*"] }],
      ["blocked-wire", { blockedModels: ["doubao-*"] }],
      ["restricted", { allowedLanes: ["balanced"] }],
    ] satisfies Array<[string, Partial<CreateKeyInput>]>)
      await new SqliteKeyStore(db).createKey({
        keyId,
        hash: hashKey(`test-${keyId}`),
        prefix: "test",
        accountId: "test",
        role: "user",
        ...extra,
      });
    vi.stubEnv("HELM_ADMIN_USER", "test-admin");
    vi.stubEnv("HELM_ADMIN_PASSWORD", "test-password");
    vi.stubEnv("ARK_API_KEY", "test-only-ark-credential");
    vi.stubEnv("HELM_DATA_DIR", dir);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", "11".repeat(32));
    vi.stubEnv("HELM_AUTH_CACHE_TTL_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        expect(new URL(request.url).origin).toBe("https://ark.cn-beijing.volces.com");
        expect(request.headers.get("authorization")).toBe("Bearer test-only-ark-credential");
        const body =
          request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
        calls.push({ path, method: request.method, body });
        if (path.endsWith("/images/generations"))
          return Response.json({
            model: body.model,
            created: 1,
            data: [
              { url: "https://example.com/result.png", size: "1024x1024", output_format: "png" },
            ],
          });
        if (request.method === "POST") {
          const id = `task-${tasks.size + 1}`;
          tasks.set(id, String(body.model));
          return Response.json({ id });
        }
        const id = path.split("/").at(-1) ?? "";
        const model = tasks.get(id);
        if (!model) throw new Error("Unknown upstream task");
        return Response.json({
          id,
          model,
          status: "succeeded",
          content: model.includes("seed3d")
            ? { file_url: "https://example.com/asset.zip" }
            : { video_url: "https://example.com/video.mp4" },
        });
      }),
    );
    const start = () =>
      buildServer({
        configDir: join(dir, "config"),
        resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
        logger: { log: () => {} },
      });
    server = await start();
    const app = server.app;
    const post = (path: string, body: unknown, key = "owner") =>
      app.request(path, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify(body),
      });
    for (const [path, body] of [
      ["/v1/images/generations", { model: "seedream-flash", prompt: "An apple" }],
      ["/v1/videos/generations", video],
      ["/v1/3d/generations", threeD],
    ] as const) {
      for (const key of ["spend", "blocked", "blocked-wire", "restricted"]) {
        const denied = await post(path, body, key);
        expect(denied.status, `${path} ${key}: ${await denied.text()}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(calls).toHaveLength(0);
    const adminModels = await server.app.request("/admin/api/models", {
      headers: {
        Authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}`,
      },
    });
    expect(await adminModels.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: "ark/seedream-5.0-flash", outputKind: "image" }),
        expect.objectContaining({ alias: "ark/seedance-2.5", outputKind: "video" }),
        expect.objectContaining({ alias: "ark/seed3d-2.0", outputKind: "3d" }),
      ]),
    );
    const modelsResponse = await server.app.request("/v1/models", { headers: headers() });
    const models = (await modelsResponse.json()) as {
      data: { id: string; capabilities?: { outputThreeD?: boolean } }[];
    };
    expect(models.data.find((m) => m.id === "ark/seed3d-2.0")?.capabilities?.outputThreeD).toBe(
      true,
    );
    for (const model of ["seedream-flash", "doubao-seedream-5-0-pro-260628"]) {
      const result = await post("/v1/images/generations", { model, prompt: "An apple" });
      expect(result.status, await result.text()).toBe(200);
    }
    expect(calls.map((call) => call.body.model)).toEqual([
      "doubao-seedream-5-0-flash-260915",
      "doubao-seedream-5-0-pro-260628",
    ]);
    const created = [];
    for (const [kind, body] of [
      ["videos", video],
      ["3d", threeD],
    ] as const) {
      const result = await post(`/v1/${kind}/generations`, body);
      const content = (await result.json()) as { request_id: string };
      expect(result.status, JSON.stringify(content)).toBe(200);
      expect(content.request_id).toBeTruthy();
      expect(content.request_id.startsWith("task-")).toBe(false);
      created.push({ kind, id: content.request_id });
    }
    await server.dispose?.();
    server = await start();
    for (const { kind, id } of created) {
      const before = calls.length;
      expect(
        (await server.app.request(`/v1/${kind}/${id}`, { headers: headers("other") })).status,
      ).toBe(404);
      expect(calls).toHaveLength(before);
      const result = await server.app.request(`/v1/${kind}/${id}`, { headers: headers() });
      const body = (await result.json()) as { status: string };
      expect(result.status, JSON.stringify(body)).toBe(200);
      expect(body.status).toBe("done");
    }
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(4);
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});
