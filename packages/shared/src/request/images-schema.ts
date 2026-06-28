import { z } from "zod";

// OpenAI Images API — POST /v1/images/generations (the `gpt-image-*` / DALL·E
// surface). A dedicated endpoint distinct from chat/messages/responses: the body
// is `{model, prompt, ...}` and the response carries generated images as
// `data[].b64_json`, billed as OUTPUT tokens (usage.output_tokens, image_tokens).
//
// `model` + `prompt` are the only requireds; everything else is optional and the
// object is LOOSE (z.looseObject, like OpenAIChatRequestSchema) so unknown/future
// fields (style, moderation, …) ride through to the upstream verbatim — helm never
// strips a client field it doesn't model.
export const ImageGenerationRequestSchema = z.looseObject({
  model: z.string().min(1),
  prompt: z.string().min(1),
  n: z.number().int().positive().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  response_format: z.string().optional(), // "b64_json" | "url"
  background: z.string().optional(),
  output_format: z.string().optional(),
  user: z.string().optional(),
});

// Upstream usage shape (OpenAI Images): the generated image is billed as
// output_tokens (= output_tokens_details.image_tokens). Loose — typing only for
// the cost path; the route forwards the upstream body verbatim, never reshapes it.
export const ImageUsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  output_tokens_details: z
    .looseObject({ image_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});

export const ImageGenerationResponseSchema = z.looseObject({
  created: z.number().optional(),
  data: z.array(z.looseObject({ b64_json: z.string().optional(), url: z.string().optional() })),
  usage: ImageUsageSchema.optional(),
});

export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>;
export type ImageGenerationResponse = z.infer<typeof ImageGenerationResponseSchema>;
