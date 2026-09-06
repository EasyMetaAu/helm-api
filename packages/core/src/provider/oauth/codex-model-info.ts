import { z } from "zod";

export const ReasoningEffortSchema = z.string().min(1);

export const CodexReasoningEffortPresetSchema = z
  .object({
    effort: ReasoningEffortSchema,
    description: z.string(),
  })
  .passthrough();

export const CodexModelServiceTierSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
  })
  .passthrough();

export const CodexModelAvailabilityNuxSchema = z
  .object({
    message: z.string(),
  })
  .passthrough();

export const CodexModelInfoUpgradeSchema = z
  .object({
    model: z.string(),
    migration_markdown: z.string(),
  })
  .passthrough();

export const CodexModelInstructionsVariablesSchema = z
  .object({
    personality_default: z.string().nullable().optional(),
    personality_friendly: z.string().nullable().optional(),
    personality_pragmatic: z.string().nullable().optional(),
  })
  .passthrough();

export const CodexApprovalMessagesSchema = z
  .object({
    on_request: z.string().nullable().optional(),
    on_request_auto_review: z.string().nullable().optional(),
  })
  .passthrough();

export const CodexModelMessagesSchema = z
  .object({
    instructions_template: z.string().nullable().optional(),
    instructions_variables: CodexModelInstructionsVariablesSchema.nullable().optional(),
    approvals: CodexApprovalMessagesSchema.nullable().optional(),
  })
  .passthrough();

export const CodexTruncationPolicySchema = z
  .object({
    mode: z.enum(["bytes", "tokens"]),
    limit: z.number().int(),
  })
  .passthrough();

export const CodexClientVersionSchema = z.union([
  z.string().min(1),
  z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
]);

const CODEX_TOOL_MODES = ["direct", "code_mode", "code_mode_only"] as const;
const CODEX_MULTI_AGENT_VERSIONS = ["disabled", "v1", "v2"] as const;

function optionalKnownSelector<const T extends readonly [string, ...string[]]>(values: T) {
  const allowed = new Set<string>(values);
  return z.preprocess(
    (value) => (typeof value === "string" && allowed.has(value) ? value : undefined),
    z.enum(values).optional(),
  );
}

export const CodexModelInfoSchema = z
  .object({
    slug: z.string().min(1),
    display_name: z.string().min(1),
    description: z.string().nullable().optional(),
    default_reasoning_level: ReasoningEffortSchema.nullable().optional(),
    supported_reasoning_levels: z.array(CodexReasoningEffortPresetSchema),
    shell_type: z.enum(["default", "local", "unified_exec", "disabled", "shell_command"]),
    visibility: z.enum(["list", "hide", "none"]),
    minimal_client_version: CodexClientVersionSchema.nullable().optional(),
    supported_in_api: z.boolean(),
    priority: z.number().int(),
    additional_speed_tiers: z.array(z.string()).default([]),
    service_tiers: z.array(CodexModelServiceTierSchema).default([]),
    default_service_tier: z.string().nullable().optional(),
    availability_nux: CodexModelAvailabilityNuxSchema.nullable().optional(),
    upgrade: CodexModelInfoUpgradeSchema.nullable().optional(),
    // Legacy top-level field. Upstream codex (protocol::openai_models) now treats it
    // as optional and promotes it into model_messages.instructions_template; newer
    // catalog entries (e.g. gpt-6-astra) omit it entirely.
    base_instructions: z.string().nullable().optional(),
    model_messages: CodexModelMessagesSchema.nullable().optional(),
    include_skills_usage_instructions: z.boolean().default(false),
    supports_reasoning_summaries: z.boolean(),
    default_reasoning_summary: z.enum(["auto", "concise", "detailed", "none"]).default("auto"),
    support_verbosity: z.boolean(),
    default_verbosity: z.enum(["low", "medium", "high"]).nullable().optional(),
    apply_patch_tool_type: z.enum(["freeform"]).nullable().optional(),
    web_search_tool_type: z.enum(["text", "text_and_image"]).default("text"),
    truncation_policy: CodexTruncationPolicySchema,
    supports_parallel_tool_calls: z.boolean(),
    supports_image_detail_original: z.boolean().default(false),
    context_window: z.number().int().nullable().optional(),
    max_context_window: z.number().int().nullable().optional(),
    auto_compact_token_limit: z.number().int().nullable().optional(),
    comp_hash: z.string().nullable().optional(),
    effective_context_window_percent: z.number().int().default(95),
    experimental_supported_tools: z.array(z.string()),
    input_modalities: z.array(z.enum(["text", "image", "audio"])).default(["text", "image"]),
    supports_search_tool: z.boolean().default(false),
    use_responses_lite: z.boolean().default(false),
    auto_review_model_override: z.string().nullable().optional(),
    tool_mode: optionalKnownSelector(CODEX_TOOL_MODES),
    multi_agent_version: optionalKnownSelector(CODEX_MULTI_AGENT_VERSIONS),
  })
  .passthrough();

export const CodexModelsResponseSchema = z
  .object({
    models: z.array(CodexModelInfoSchema),
  })
  .passthrough();

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type CodexReasoningEffortPreset = z.infer<typeof CodexReasoningEffortPresetSchema>;
export type CodexModelInfo = z.infer<typeof CodexModelInfoSchema>;
export type CodexModelsResponse = z.infer<typeof CodexModelsResponseSchema>;
