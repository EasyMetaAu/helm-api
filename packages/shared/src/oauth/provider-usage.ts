import { z } from "zod";
import { ApiKeyAccountViewSchema } from "../config/api-key-pool.js";
import { AnthropicPlanTypeSchema } from "./anthropic-plan.js";
import { OAuthQuotaSnapshotSchema } from "./usage-schema.js";

// Explicit read-only projection: never export credentials, proxy settings, or controls.
export const ProviderUsageSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.number().int(),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      accounts: z.array(
        z.object({
          account: z.string(),
          email: z.string().optional(),
          healthy: z.boolean(),
          schedulable: z.boolean(),
          credentialFailed: z.boolean().optional(),
          anthropicPlanType: AnthropicPlanTypeSchema.nullish(),
          chatgptPlanType: z.string().optional(),
        }),
      ),
    }),
  ),
  usage: z.array(
    z.object({
      providerId: z.string(),
      account: z.string(),
      requests: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      costUsd: z.number().nullable(),
      rpm: z.number().nonnegative(),
    }),
  ),
  apiKeyPools: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        accounts: z.array(
          ApiKeyAccountViewSchema.pick({
            id: true,
            name: true,
            enabled: true,
            state: true,
            nextRetryAt: true,
          }),
        ),
        usage: z.array(
          z.object({
            account: z.string(),
            requests: z.number(),
            tokens: z.number(),
            costUsd: z.number().nullable(),
          }),
        ),
      }),
    )
    .default([]),
  quota: z.array(OAuthQuotaSnapshotSchema.omit({ identity: true }).strip()),
});
export type ProviderUsageSnapshot = z.infer<typeof ProviderUsageSnapshotSchema>;
export const UpstreamProviderUsageSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    source: z.string(),
    snapshot: ProviderUsageSnapshotSchema,
  }),
]);
export type UpstreamProviderUsage = z.infer<typeof UpstreamProviderUsageSchema>;
