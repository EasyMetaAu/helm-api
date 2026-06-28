import { ModelObjectSchema, ModelsListSchema, OpenAIChatRequestSchema } from "@helm/shared";
import { swaggerUI } from "@hono/swagger-ui";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import type { BuildInfo } from "../build-info.js";

// OpenAPI 3.1 spec + Swagger UI for the public API surface. The spec is BUILT
// FROM the Zod schemas (z.toJSONSchema) so request/response shapes stay a single
// source of truth (CLAUDE.md): the docs cannot drift from what the router
// actually validates. 3.1 is chosen deliberately — it is a superset of JSON
// Schema draft-2020-12, exactly what z.toJSONSchema emits, so generated component
// schemas drop in without translation. Paths are hand-described (the existing
// routes are plain Hono handlers, not OpenAPIHono) and cover the PRIMARY surface;
// admin endpoints are intentionally omitted (internal). All three doc endpoints
// (/openapi.json, /docs) are PUBLIC — they expose only the schema, never data.

type JsonSchema = Record<string, unknown>;

// Convert a Zod schema to a JSON-Schema component. z.toJSONSchema emits a top-level
// `$schema` (meta) we strip — OpenAPI components must not carry it.
function component(schema: z.ZodType): JsonSchema {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12" }) as JsonSchema;
  delete js.$schema;
  return js;
}

// The OpenAI error envelope (`{ error: { message, type, code, trace_id } }`) — the
// wire shape every gateway error is rendered into (middleware/error-handler). Hand-
// authored: it is a protocol-layer shape, not a Zod-validated input.
const ERROR_ENVELOPE: JsonSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        message: { type: "string" },
        type: { type: "string" },
        code: { type: "string" },
        trace_id: { type: "string" },
      },
      required: ["message", "type", "code", "trace_id"],
    },
  },
  required: ["error"],
};

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
});

export function buildOpenApiDocument(buildInfo?: BuildInfo): JsonSchema {
  return {
    openapi: "3.1.0",
    info: {
      title: "Helm API",
      version: buildInfo?.version ?? "unknown",
      description:
        "Open-source, self-hosted LLM router gateway. Send OpenAI, Anthropic, or " +
        "Gemini-shaped requests; Helm classifies and routes them across providers. " +
        "Authenticate protected endpoints with `Authorization: Bearer <api-key>`.",
    },
    servers: [{ url: "/", description: "This gateway" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Helm API key" },
      },
      schemas: {
        ModelsList: component(ModelsListSchema),
        ModelObject: component(ModelObjectSchema),
        ChatCompletionRequest: component(OpenAIChatRequestSchema),
        ErrorEnvelope: ERROR_ENVELOPE,
      },
    },
    paths: {
      "/": {
        get: {
          tags: ["Meta"],
          summary: "Landing page",
          description: "Public status dashboard (HTML).",
          security: [],
          responses: { "200": { description: "HTML status dashboard" } },
        },
      },
      "/healthz": {
        get: {
          tags: ["Meta"],
          summary: "Readiness probe",
          security: [],
          responses: {
            "200": { description: "Ready" },
            "503": { description: "Not ready / degraded" },
          },
        },
      },
      "/version": {
        get: {
          tags: ["Meta"],
          summary: "Build info",
          security: [],
          responses: { "200": { description: "version / gitSha / builtAt" } },
        },
      },
      "/v1/models": {
        get: {
          tags: ["Models"],
          summary: "List available models",
          description:
            "Key-aware listing. Every key sees the lanes (economy, balanced, …) plus " +
            "`auto`. Keys with `allow_custom_model` also see concrete provider aliases " +
            "with capabilities and pricing.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Model list",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ModelsList" } },
              },
            },
            "401": errorResponse("Missing or invalid API key"),
          },
        },
      },
      "/v1/models/{id}": {
        get: {
          tags: ["Models"],
          summary: "Retrieve a model",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "A lane name, `auto`, or (for allow_custom_model keys) a model alias.",
            },
          ],
          responses: {
            "200": {
              description: "Model object",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ModelObject" } },
              },
            },
            "400": errorResponse("Unknown model / not available to this key"),
            "401": errorResponse("Missing or invalid API key"),
          },
        },
      },
      "/v1/chat/completions": {
        post: {
          tags: ["Inference"],
          summary: "OpenAI-compatible chat completions",
          description:
            "Set `stream: true` for an SSE stream (`text/event-stream`). The `model` " +
            "field may be a lane, `auto`, or — for allow_custom_model keys — a model alias.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatCompletionRequest" },
              },
            },
          },
          responses: {
            "200": { description: "Chat completion (JSON) or SSE stream when stream=true" },
            "401": errorResponse("Missing or invalid API key"),
            "502": errorResponse("All providers failed"),
          },
        },
      },
      "/v1/messages": {
        post: {
          tags: ["Inference"],
          summary: "Anthropic-compatible Messages API",
          description: "Self-authenticated; errors render as the Anthropic error envelope.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": { description: "Anthropic message (JSON) or SSE stream" },
            "401": { description: "Missing or invalid API key" },
          },
        },
      },
      "/v1/responses": {
        post: {
          tags: ["Inference"],
          summary: "OpenAI Responses API",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": { description: "Response (JSON) or SSE stream" },
            "401": errorResponse("Missing or invalid API key"),
          },
        },
      },
      "/v1/images/generations": {
        post: {
          tags: ["Inference"],
          summary: "OpenAI-compatible image generation",
          description:
            "Generate images from a text prompt. Model-pinned: `model` is the exact " +
            "image model id (e.g. `gpt-image-2`, `gemini-3.1-flash-image`) — NOT a lane " +
            "or `auto`, and `allow_custom_model` is not required. No classification, " +
            "lanes, or cross-protocol translation; the request is forwarded to the " +
            "named model's provider. Non-streaming. Per-key budget and rate limits apply.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": { description: "Images response (`{ created, data: [{ b64_json }], usage }`)" },
            "400": errorResponse("Invalid image generation request"),
            "401": errorResponse("Missing or invalid API key"),
            "404": errorResponse("Model is not a configured image model"),
            "503": errorResponse("Image provider unavailable (missing credential)"),
          },
        },
      },
      "/v1beta/interactions": {
        post: {
          tags: ["Inference"],
          summary: "Gemini Interactions API image generation",
          description:
            "Generate images via the Google Gemini Interactions API (the SDK's " +
            "`client.interactions.create`). Model-pinned to a Gemini image model " +
            "(`gemini-3.1-flash-image`, `gemini-3-pro-image`) — `allow_custom_model` is " +
            "not required (any key). Auth via `x-goog-api-key` (Bearer fallback). Helm " +
            "translates the request to a `generateContent` call and maps the response " +
            "back to the interactions `steps[]` shape. An OpenAI image model (gpt-image-2) " +
            "is a 400 → use /v1/images/generations. Non-streaming; budget + rate limits apply.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": {
              description:
                "Interactions response (`{ id, steps: [{ content: [{ type, data }] }] }`)",
            },
            "400": errorResponse("Invalid request, or an OpenAI image model"),
            "401": errorResponse("Missing or invalid API key"),
            "404": errorResponse("Model is not a configured image model"),
            "503": errorResponse("Image provider unavailable (missing credential)"),
          },
        },
      },
    },
  };
}

export interface OpenApiRouteDeps {
  buildInfo?: BuildInfo;
}

export function registerOpenApiRoutes(app: Hono<AppEnv>, deps: OpenApiRouteDeps = {}): void {
  // Build once at registration — the spec is static for the process lifetime.
  const doc = buildOpenApiDocument(deps.buildInfo);
  app.get("/openapi.json", (c) => c.json(doc));
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));
}
