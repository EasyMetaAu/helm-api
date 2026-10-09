import { z } from "zod";

export const AnthropicPlanTypeSchema = z.enum(["pro", "max", "team", "enterprise"]);
export type AnthropicPlanType = z.infer<typeof AnthropicPlanTypeSchema>;
