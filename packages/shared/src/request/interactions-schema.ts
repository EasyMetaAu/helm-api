import { z } from "zod";

// Google Gemini Interactions API — POST /v1beta/interactions (the modern image-gen
// surface for the gemini-*-image "Nano Banana" models; the SDK's
// `client.interactions.create(...)`). A dedicated endpoint distinct from
// chat/messages/responses/images: the request is `{model, input, response_format}`
// and the response is a `steps[]` array whose `model_output` step carries the image
// as `content[].{type:"image", mime_type, data}` (base64).
//
// Helm's upstream (ZenMux Vertex) speaks `generateContent`, NOT `/v1beta/interactions`,
// so the route TRANSLATES this request to a generateContent call (responseModalities
// IMAGE) and maps the inlineData response back to the interactions `steps` shape. Only
// `model` + `input` are required; the object is LOOSE so unknown/future fields ride
// through — Helm never strips a client field it doesn't model.

// One block of structured `input` (text or inline image). Loose: future block types
// (video, audio) and fields pass through to the translator untouched.
export const InteractionInputBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  data: z.string().optional(), // base64 (image/video block)
  mime_type: z.string().optional(),
});

// `input` is EITHER a bare prompt string OR an ordered array of typed blocks.
export const InteractionInputSchema = z.union([
  z.string().min(1),
  z.array(InteractionInputBlockSchema).min(1),
]);

// Desired output format (image generation). Loose — aspect_ratio / image_size are
// best-effort mapped to generateContent's imageConfig; unknown keys pass through.
export const InteractionResponseFormatSchema = z.looseObject({
  type: z.string(), // "image"
  mime_type: z.string().optional(),
  aspect_ratio: z.string().optional(),
  image_size: z.string().optional(),
});

export const InteractionsRequestSchema = z.looseObject({
  model: z.string().min(1),
  input: InteractionInputSchema,
  response_format: InteractionResponseFormatSchema.optional(),
  generation_config: z.looseObject({}).optional(),
});

// Response (new `steps` schema). Typing is for the route's own mapping clarity; the
// route BUILDS this shape from the translated generateContent body — it is not parsed
// from a client.
export const InteractionContentBlockSchema = z.looseObject({
  type: z.string(), // "text" | "image"
  text: z.string().optional(),
  mime_type: z.string().optional(),
  data: z.string().optional(), // base64 image
});

export const InteractionStepSchema = z.looseObject({
  type: z.string(), // "model_output"
  status: z.string().optional(),
  content: z.array(InteractionContentBlockSchema).optional(),
});

export const InteractionsResponseSchema = z.looseObject({
  id: z.string(),
  steps: z.array(InteractionStepSchema),
});

export type InteractionsRequest = z.infer<typeof InteractionsRequestSchema>;
export type InteractionsResponse = z.infer<typeof InteractionsResponseSchema>;
export type InteractionInputBlock = z.infer<typeof InteractionInputBlockSchema>;
