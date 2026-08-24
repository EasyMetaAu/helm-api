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

// Fast Imagine keeps the bounded web options already exposed by Helm.
// The older quality model stays on the generic compatibility path in the route.
export const GrokImagineImageGenerationRequestSchema = z.strictObject({
  model: z.literal("grok-imagine-image"),
  prompt: z.string().min(1),
  n: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).optional(),
  resolution: z.literal("1k").optional(),
  response_format: z.literal("b64_json").optional(),
});

// The quality model keeps its existing loose compatibility surface, while
// explicitly advertising the two client-side picture-book crops Helm adds.
export const GrokImagineQualityImageGenerationRequestSchema = z.looseObject({
  model: z.literal("grok-imagine-image-quality"),
  prompt: z.string().min(1),
  n: z.number().int().positive().optional(),
  aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3", "3:4", "4:5"]).optional(),
  resolution: z.string().optional(),
  response_format: z.enum(["b64_json", "url"]).optional(),
});

const ImageEditCommonShape = {
  model: z.string().min(1),
  prompt: z.string().min(1),
  n: z.number().int().positive().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  background: z.string().optional(),
  output_format: z.string().optional(),
};

export const ImageEditRequestSchema = z.union([
  z.looseObject({
    ...ImageEditCommonShape,
    image: z.looseObject({ url: z.string().min(1) }),
  }),
  z.looseObject({
    ...ImageEditCommonShape,
    images: z
      .array(
        z.union([
          z.looseObject({ image_url: z.string().min(1) }),
          z.looseObject({ file_id: z.string().min(1) }),
          z.looseObject({ url: z.string().min(1) }),
        ]),
      )
      .min(1),
  }),
]);

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
export type GrokImagineImageGenerationRequest = z.infer<
  typeof GrokImagineImageGenerationRequestSchema
>;
export type GrokImagineQualityImageGenerationRequest = z.infer<
  typeof GrokImagineQualityImageGenerationRequestSchema
>;
export type ImageEditRequest = z.infer<typeof ImageEditRequestSchema>;
export type ImageGenerationResponse = z.infer<typeof ImageGenerationResponseSchema>;
