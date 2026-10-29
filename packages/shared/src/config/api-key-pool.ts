import { z } from "zod";

export const ApiKeyPoolConfigSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    strategy: z.enum(["round_robin", "manual_priority"]).default("round_robin"),
    reset_timezone: z
      .string()
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "invalid IANA timezone")
      .default("Asia/Shanghai"),
  })
  .strict();
export const UpstreamApiKeySchema = z
  .string()
  .trim()
  .min(12)
  .max(512)
  .regex(/^sk-[A-Za-z0-9_-]+$/)
  .refine((key) => !key.startsWith("sk-admin-"), "Admin keys cannot serve model requests");
export const ApiKeyAccountInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    key: UpstreamApiKeySchema,
  })
  .strict();
export const ApiKeyAccountPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    key: UpstreamApiKeySchema.optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    models: z.array(z.string().min(1).max(200)).max(500).nullable().optional(),
  })
  .strict();
export type ApiKeyPoolConfig = z.infer<typeof ApiKeyPoolConfigSchema>;
export type ApiKeyAccountInput = z.infer<typeof ApiKeyAccountInputSchema>;
export type ApiKeyAccountPatch = z.infer<typeof ApiKeyAccountPatchSchema>;

export const ApiKeyAccountViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  mask: z.string(),
  enabled: z.boolean(),
  priority: z.number(),
  models: z.array(z.string()).nullable(),
  state: z.enum(["ready", "cooldown", "quota_exhausted", "invalid"]),
  reason: z.string().nullable(),
  nextRetryAt: z.number().nullable(),
  probeUntil: z.number().nullable(),
  deniedModels: z.array(z.string()),
});
export type ApiKeyAccountView = z.infer<typeof ApiKeyAccountViewSchema>;

export const ApiKeyPoolsViewSchema = z.object({
  pools: z.array(
    z.object({
      id: z.string(),
      configured: z.boolean(),
      timezone: z.string(),
      strategy: z.enum(["round_robin", "manual_priority"]),
      models: z.array(z.string()),
      accounts: z.array(ApiKeyAccountViewSchema),
      usage: z.array(
        z.object({
          account: z.string(),
          requests: z.number(),
          tokens: z.number(),
          costUsd: z.number().nullable(),
        }),
      ),
    }),
  ),
});
export type ApiKeyPoolView = z.infer<typeof ApiKeyPoolsViewSchema>["pools"][number];
