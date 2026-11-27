import { z } from "zod";
import { CapabilitiesSchema, PricingSchema } from "../catalog/schema.js";

export const ProviderProxySchema = z
  .object({
    type: z.enum(["http", "https", "socks5"]),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .refine((v) => !/[\s/@?#]/.test(v)),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(512).optional(),
    password: z.string().max(4096).optional(),
  })
  .strict();
export const ProviderParametersSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
  })
  .strict();
export const ManagedProviderInputSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .refine((v) => !["anthropic", "openai-codex", "github-copilot", "xai"].includes(v)),
    label: z.string().trim().min(1).max(80),
    type: z.enum([
      "openai",
      "openai-responses-generic",
      "anthropic",
      "gemini",
      "deepseek-responses",
      "helm",
      "ark",
      "bailian-media",
      "minimax-media",
      "doubao-speech",
      "openai-audio",
      "deepgram",
      "whisperx-asr",
    ]),
    base_url: z.url().refine((value) => {
      const u = new URL(value);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    }, "Use an HTTP(S) URL without credentials, query or fragment"),
    media_account_id: z.string().trim().min(1).max(128).optional(),
    models: z
      .array(
        z
          .object({
            alias: z.string().trim().min(1).max(200),
            provider_model: z.string().trim().min(1).max(200),
            capabilities: CapabilitiesSchema.optional(),
            pricing: PricingSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    map_developer_role_to_system: z.boolean().default(false),
    normalize_reasoning_delta_alias: z.boolean().default(false),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.models.map((m) => m.alias)).size !== p.models.length)
      ctx.addIssue({ code: "custom", path: ["models"], message: "Model aliases must be unique" });
    if (p.models.some((m) => /^(anthropic|openai-codex|github-copilot|xai)\//.test(m.alias)))
      ctx.addIssue({
        code: "custom",
        path: ["models"],
        message: "Subscription aliases are reserved",
      });
    if (["bailian-media", "minimax-media", "doubao-speech"].includes(p.type)) {
      const u = new URL(p.base_url);
      const path = p.type === "bailian-media" ? "/api/v1" : "";
      if (!p.media_account_id || u.protocol !== "https:" || u.pathname.replace(/\/+$/, "") !== path)
        ctx.addIssue({
          code: "custom",
          path: ["base_url"],
          message: "Native media requires an account identity and its HTTPS API base endpoint",
        });
    }
  });
export type ManagedProviderInput = z.infer<typeof ManagedProviderInputSchema>;
export type ProviderProxy = z.infer<typeof ProviderProxySchema>;
export type ProviderParameters = z.infer<typeof ProviderParametersSchema>;
export const ManagedProviderViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  base_url: z.string(),
  models: z.array(ManagedProviderInputSchema.shape.models.element),
  media_account_id: z.string().optional(),
  map_developer_role_to_system: z.boolean().default(false),
  normalize_reasoning_delta_alias: z.boolean().default(false),
  poolId: z.string(),
  keyless: z.boolean().default(false),
  managed: z.boolean(),
  legacyCredentialAvailable: z.boolean(),
});
export type ManagedProviderView = z.infer<typeof ManagedProviderViewSchema>;
