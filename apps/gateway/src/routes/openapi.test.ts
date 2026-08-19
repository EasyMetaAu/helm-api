import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { buildOpenApiDocument } from "./openapi.js";

describe("OpenAPI docs", () => {
  it("GET /openapi.json returns a 3.1 spec covering the public surface", async () => {
    const app = createApp({ logger: { log: () => {} } });
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, { get: { security: unknown }; post?: { security: unknown } }>;
      components: {
        schemas: Record<string, Record<string, unknown>>;
        securitySchemes: Record<string, Record<string, unknown>>;
      };
    };
    expect(doc.openapi).toBe("3.1.0");
    // Every primary surface is covered — the four client protocols + both image endpoints.
    for (const path of [
      "/",
      "/healthz",
      "/version",
      "/v1/models",
      "/v1/usage/stats",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/videos/generations",
      "/v1/videos/extensions",
      "/v1/videos/{requestId}",
      "/v1/realtime/calls",
      "/v1/live",
      "/v1beta/interactions",
      "/v1beta/models/{model}:generateContent",
    ]) {
      expect(doc.paths[path]).toBeDefined();
    }
    // Components are generated from the Zod schemas; the meta `$schema` is stripped.
    const modelsList = doc.components.schemas.ModelsList;
    expect(modelsList).toBeDefined();
    expect(modelsList?.$schema).toBeUndefined();
    // Image/interactions bodies reuse their Zod schemas (single source of truth).
    for (const name of [
      "ImageGenerationRequest",
      "GrokImagineImageGenerationRequest",
      "ImageEditRequest",
      "ImageGenerationResponse",
      "VideoGenerationRequest",
      "VideoExtensionRequest",
      "VideoGenerationResponse",
      "VideoRetrieveResponse",
      "InteractionsRequest",
      "InteractionsResponse",
      "RealtimeSession",
    ]) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
    // The Gemini-native endpoints advertise the `x-goog-api-key` auth scheme.
    expect(doc.components.securitySchemes.googleApiKey).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-goog-api-key",
    });
    expect(doc.paths["/v1beta/interactions"]?.post?.security).toEqual([
      { googleApiKey: [] },
      { bearerAuth: [] },
    ]);
    // /v1/models is marked as bearer-secured; / is public.
    expect(doc.paths["/v1/models"]?.get.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths["/v1/usage/stats"]?.get.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.schemas.UsageStats).toBeDefined();
    expect(doc.paths["/"]?.get.security).toEqual([]);
  });

  it("GET /docs serves Swagger UI HTML", async () => {
    const app = createApp({ logger: { log: () => {} } });
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("swagger");
  });

  it("buildOpenApiDocument stamps the build version into info", () => {
    const doc = buildOpenApiDocument({ version: "1.2.3", gitSha: "abc", builtAt: "now" });
    expect((doc.info as { version: string }).version).toBe("1.2.3");
  });
});
