import {
  GrokImagineImageGenerationRequestSchema,
  GrokImagineQualityImageGenerationRequestSchema,
  ImageEditRequestSchema,
  ImageGenerationRequestSchema,
  ImageGenerationResponseSchema,
  InteractionsRequestSchema,
  InteractionsResponseSchema,
  ModelObjectSchema,
  ModelsListSchema,
  OpenAIChatRequestSchema,
  RealtimeSessionSchema,
  VideoExtensionRequestSchema,
  VideoGenerationRequestSchema,
  VideoGenerationResponseSchema,
  VideoRetrieveResponseSchema,
} from "@helm/shared";
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
// routes are plain Hono handlers, not OpenAPIHono) and cover the PRIMARY surface
// — the four client protocols (OpenAI chat, Anthropic messages, OpenAI Responses,
// Gemini generateContent) plus the two image-generation endpoints; admin endpoints
// are intentionally omitted (internal). Request/response bodies reuse the Zod
// schemas wherever one exists (chat, images, interactions); the loose-passthrough
// surfaces (Anthropic, Responses, Gemini) carry a runnable `example` instead of a
// fabricated full schema, since the route forwards those bodies provider-native.
// The doc endpoints (/openapi.json, /docs) are PUBLIC — they expose only the
// schema, never data.

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
    externalDocs: {
      description: "Helm documentation (routing, lanes, protocol translation, image generation)",
      url: "https://github.com/EasyMetaAu/helm-api#readme",
    },
    tags: [
      { name: "Meta", description: "Landing page, readiness, and build info — no auth." },
      { name: "Models", description: "What the key can route to: lanes, `auto`, and aliases." },
      {
        name: "Usage",
        description: "Read-only telemetry aggregates scoped to the authenticated API key.",
      },
      {
        name: "Inference",
        description:
          'The four client protocols plus image generation. Send `model: "auto"` to let ' +
          "Helm classify and route, a lane name to pin a lane, or an exact image model id " +
          "on the image endpoints. Streaming replies are `text/event-stream` (SSE).",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Helm API key — `Authorization: Bearer <api-key>`.",
        },
        googleApiKey: {
          type: "apiKey",
          in: "header",
          name: "x-goog-api-key",
          description:
            "Helm API key in the Gemini SDK's native header (the Gemini endpoints also " +
            "accept `Authorization: Bearer`).",
        },
      },
      schemas: {
        ModelsList: component(ModelsListSchema),
        ModelObject: component(ModelObjectSchema),
        ChatCompletionRequest: component(OpenAIChatRequestSchema),
        ImageEditRequest: component(ImageEditRequestSchema),
        GrokImagineImageGenerationRequest: component(GrokImagineImageGenerationRequestSchema),
        GrokImagineQualityImageGenerationRequest: component(
          GrokImagineQualityImageGenerationRequestSchema,
        ),
        ImageGenerationRequest: component(ImageGenerationRequestSchema),
        ImageGenerationResponse: component(ImageGenerationResponseSchema),
        InteractionsRequest: component(InteractionsRequestSchema),
        InteractionsResponse: component(InteractionsResponseSchema),
        RealtimeSession: component(RealtimeSessionSchema),
        VideoExtensionRequest: component(VideoExtensionRequestSchema),
        VideoGenerationRequest: component(VideoGenerationRequestSchema),
        VideoGenerationResponse: component(VideoGenerationResponseSchema),
        VideoRetrieveResponse: component(VideoRetrieveResponseSchema),
        UsageStats: {
          type: "object",
          properties: {
            object: { const: "usage_stats" },
            api_key_id: { type: "string" },
            range: {
              type: "object",
              properties: {
                start_ms: { type: "integer", minimum: 0 },
                end_ms: { type: "integer", minimum: 0 },
                bucket: { enum: ["hour", "day"] },
                tz_offset_minutes: { type: "integer", minimum: -720, maximum: 840 },
              },
              required: ["start_ms", "end_ms", "bucket", "tz_offset_minutes"],
            },
            totals: {
              type: "object",
              properties: {
                requests: { type: "integer", minimum: 0 },
                ok_count: { type: "integer", minimum: 0 },
                error_count: { type: "integer", minimum: 0 },
                prompt_tokens: { type: "integer", minimum: 0 },
                completion_tokens: { type: "integer", minimum: 0 },
                total_tokens: { type: "integer", minimum: 0 },
                cached_tokens: { type: "integer", minimum: 0 },
                cache_creation_tokens: { type: "integer", minimum: 0 },
                cost_usd: { type: "number", minimum: 0 },
              },
              required: [
                "requests",
                "ok_count",
                "error_count",
                "prompt_tokens",
                "completion_tokens",
                "total_tokens",
                "cached_tokens",
                "cache_creation_tokens",
                "cost_usd",
              ],
            },
          },
          required: ["object", "api_key_id", "range", "totals"],
        },
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
      "/v1/usage/stats": {
        get: {
          tags: ["Usage"],
          summary: "Get usage stats for the authenticated key",
          description:
            "Returns compact token, request, and cost totals scoped to the API key used " +
            "for authentication. `key_id` query parameters are ignored; callers cannot " +
            "read another key's usage through this endpoint.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "start",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 0 },
              description: "Inclusive epoch-ms lower bound. Defaults to 0 for cumulative usage.",
            },
            {
              name: "end",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 0 },
              description: "Exclusive epoch-ms upper bound. Defaults to the current server time.",
            },
            {
              name: "bucket",
              in: "query",
              required: false,
              schema: { enum: ["hour", "day"], default: "day" },
              description: "Telemetry aggregation bucket. Present for query parity with stats.",
            },
            {
              name: "tzOffsetMinutes",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: -720, maximum: 840, default: 0 },
              description: "East-positive timezone offset used for bucket flooring.",
            },
          ],
          responses: {
            "200": {
              description: "Usage totals scoped to the authenticated key",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/UsageStats" } },
              },
            },
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
                example: {
                  model: "auto",
                  messages: [
                    { role: "user", content: "Explain consistent hashing in two sentences." },
                  ],
                  stream: false,
                },
              },
            },
          },
          responses: {
            "200": { description: "Chat completion (JSON) or SSE stream when stream=true" },
            "400": errorResponse("Invalid request (e.g. forbidden lane on a custom-model key)"),
            "401": errorResponse("Missing or invalid API key"),
            "502": errorResponse("All providers failed"),
          },
        },
      },
      "/v1/messages": {
        post: {
          tags: ["Inference"],
          summary: "Anthropic-compatible Messages API",
          description:
            "Send an Anthropic Messages body verbatim — Helm routes it and translates the " +
            'reply back to the Anthropic shape. `model: "auto"` classifies; a lane name ' +
            "pins a lane. Set `stream: true` for SSE. The body is forwarded provider-native, " +
            "so any Anthropic field rides through; errors render as the Anthropic error envelope.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" },
                example: {
                  model: "auto",
                  max_tokens: 1024,
                  messages: [
                    { role: "user", content: "Explain consistent hashing in two sentences." },
                  ],
                },
              },
            },
          },
          responses: {
            "200": { description: "Anthropic message (JSON) or SSE stream" },
            "400": errorResponse("Invalid request"),
            "401": errorResponse("Missing or invalid API key"),
          },
        },
      },
      "/v1/responses": {
        post: {
          tags: ["Inference"],
          summary: "OpenAI Responses API",
          description:
            'OpenAI Responses body (the `input` + `instructions` shape). `model: "auto"` ' +
            "classifies; a lane name pins a lane. Set `stream: true` for SSE. Forwarded " +
            "provider-native, so unmodelled fields pass through.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" },
                example: { model: "auto", input: "Explain consistent hashing in two sentences." },
              },
            },
          },
          responses: {
            "200": { description: "Response (JSON) or SSE stream" },
            "400": errorResponse("Invalid request"),
            "401": errorResponse("Missing or invalid API key"),
          },
        },
      },
      "/v1/images/generations": {
        post: {
          tags: ["Inference"],
          summary: "OpenAI-compatible image generation",
          description:
            "Generate images from a text prompt. `model` may be an exact image model id " +
            "(e.g. `gpt-image-2`, `gemini-3.1-flash-image`) or an image lane such as " +
            "`gpt-image` / `gemini-image`; `auto` is not used, and `allow_custom_model` " +
            "is not required. Helm skips text classification, resolves the ordered image " +
            "chain, and fails over across image providers on provider faults. Gemini image " +
            "targets are translated to/from `generateContent`. Non-streaming. Per-key " +
            "budget and rate limits apply.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  anyOf: [
                    { $ref: "#/components/schemas/GrokImagineImageGenerationRequest" },
                    { $ref: "#/components/schemas/GrokImagineQualityImageGenerationRequest" },
                    {
                      allOf: [
                        { $ref: "#/components/schemas/ImageGenerationRequest" },
                        {
                          not: {
                            type: "object",
                            properties: {
                              model: {
                                enum: ["grok-imagine-image", "grok-imagine-image-quality"],
                              },
                            },
                            required: ["model"],
                          },
                        },
                      ],
                    },
                  ],
                },
                example: {
                  model: "gpt-image-2",
                  prompt: "a single red apple on a plain white background",
                  size: "1024x1024",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Generated image(s), billed as output tokens.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ImageGenerationResponse" },
                },
              },
            },
            "400": errorResponse("Invalid image generation request"),
            "401": errorResponse("Missing or invalid API key"),
            "404": errorResponse("Model is not a configured image model"),
            "503": errorResponse("Image provider unavailable (missing credential)"),
          },
        },
      },
      "/v1/videos/generations": {
        post: {
          tags: ["Inference"],
          summary: "Start Grok Imagine video generation",
          description:
            "Starts one asynchronous, account-pinned SuperGrok OAuth video task. " +
            "A native text-only task needs only `model: grok-imagine-video` and `prompt`; " +
            "the paid create is attempted once and returns the upstream request_id.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VideoGenerationRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Video task accepted.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/VideoGenerationResponse" },
                },
              },
            },
            "400": errorResponse("Invalid video generation request"),
            "401": errorResponse("Missing or invalid API key"),
            "404": errorResponse("Model is not a configured video model"),
            "503": errorResponse("Video provider unavailable or create outcome unknown"),
          },
        },
      },
      "/v1/videos/extensions": {
        post: {
          tags: ["Inference"],
          summary: "Extend a Grok Imagine video",
          description:
            "Starts one asynchronous, account-pinned SuperGrok OAuth video extension. " +
            "The paid create is attempted once and returns the upstream request_id.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VideoExtensionRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Video extension task accepted.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/VideoGenerationResponse" },
                },
              },
            },
            "400": errorResponse("Invalid video extension request"),
            "401": errorResponse("Missing or invalid API key"),
            "404": errorResponse("Model is not a configured video model"),
            "503": errorResponse("Video provider unavailable or create outcome unknown"),
          },
        },
      },
      "/v1/videos/{requestId}": {
        get: {
          tags: ["Inference"],
          summary: "Poll a Grok Imagine video task",
          description:
            "Polls the original SuperGrok OAuth account selected at creation. " +
            "The same Helm account and API key must own the request id.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "requestId",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          responses: {
            "200": {
              description: "Current upstream video status.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/VideoRetrieveResponse" },
                },
              },
            },
            "401": errorResponse("Missing or invalid API key"),
            "404": errorResponse("Video request not found for this key"),
            "502": errorResponse("Video poll failed"),
          },
        },
      },
      "/v1/images/edits": {
        post: {
          tags: ["Inference"],
          summary: "OpenAI-compatible image edit",
          description:
            "Edit one or more images through the same authenticated image provider chain. " +
            "Codex JSON `images[].image_url` carriers and OpenAI multipart `image` files are supported.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ImageEditRequest" },
              },
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["model", "prompt", "image"],
                  properties: {
                    model: { type: "string" },
                    prompt: { type: "string" },
                    image: { type: "array", items: { type: "string", format: "binary" } },
                    mask: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Edited image(s).",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ImageGenerationResponse" },
                },
              },
            },
            "400": errorResponse("Invalid image edit request"),
            "401": errorResponse("Missing or invalid API key"),
            "404": errorResponse("Model is not a configured image model"),
          },
        },
      },
      "/v1/realtime/calls": {
        post: {
          tags: ["Inference"],
          summary: "Create a Realtime V1/V2 WebRTC call",
          description:
            "Returns the answer SDP and binds the call id to this Helm key. Join the sideband at " +
            "`wss://<helm>/v1/realtime?call_id=<id>` with the same key.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["sdp", "session"],
                  properties: {
                    sdp: { type: "string", contentMediaType: "application/sdp" },
                    session: { $ref: "#/components/schemas/RealtimeSession" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Answer SDP", content: { "application/sdp": {} } },
            "400": errorResponse("Invalid call request"),
            "401": errorResponse("Missing or invalid API key"),
          },
        },
      },
      "/v1/live": {
        post: {
          tags: ["Inference"],
          summary: "Create a Realtime V3 Frameless call",
          description:
            "Creates a Frameless call. Join its sideband at `wss://<helm>/v1/live/<call_id>` " +
            "with the same Helm key.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["sdp", "session"],
                  properties: {
                    sdp: { type: "string", contentMediaType: "application/sdp" },
                    session: { $ref: "#/components/schemas/RealtimeSession" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Answer SDP", content: { "application/sdp": {} } },
            "400": errorResponse("Invalid call request"),
            "401": errorResponse("Missing or invalid API key"),
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
          security: [{ googleApiKey: [] }, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/InteractionsRequest" },
                example: {
                  model: "gemini-3.1-flash-image",
                  input: "a single red apple on a plain white background",
                  response_format: { type: "image", aspect_ratio: "1:1" },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Interactions response — the image lives at `steps[].content[]`.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/InteractionsResponse" },
                },
              },
            },
            "400": errorResponse("Invalid request, or an OpenAI image model"),
            "401": errorResponse("Missing or invalid API key"),
            "404": errorResponse("Model is not a configured image model"),
            "503": errorResponse("Image provider unavailable (missing credential)"),
          },
        },
      },
      "/v1beta/models/{model}:generateContent": {
        post: {
          tags: ["Inference"],
          summary: "Google Gemini generateContent",
          description:
            "The Gemini SDK's native `generateContent` path. `{model}` is a lane, `auto`, " +
            "or (for allow_custom_model keys) a Gemini model alias; auth via `x-goog-api-key` " +
            "(Bearer also accepted). For streaming, call the sibling `:streamGenerateContent` " +
            "(SSE). Naming a Gemini **image** model and asking for image output " +
            "(`responseModalities: [TEXT, IMAGE]`) returns the picture inline at " +
            "`candidates[].content.parts[].inlineData`.",
          security: [{ googleApiKey: [] }, { bearerAuth: [] }],
          parameters: [
            {
              name: "model",
              in: "path",
              required: true,
              schema: { type: "string" },
              description:
                "A lane name, `auto`, or a Gemini model id (e.g. `gemini-3.1-flash-image`).",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" },
                example: {
                  contents: [
                    { parts: [{ text: "a single red apple on a plain white background" }] },
                  ],
                  generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
                },
              },
            },
          },
          responses: {
            "200": { description: "Gemini `generateContent` response (`{ candidates: [...] }`)" },
            "400": errorResponse("Invalid request"),
            "401": errorResponse("Missing or invalid API key"),
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
