import { describe, expect, it } from "vitest";
import {
  CodexModelInfoSchema,
  CodexModelsResponseSchema,
  ReasoningEffortSchema,
} from "./codex-model-info.js";

function modelInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    default_reasoning_level: "ultra",
    supported_reasoning_levels: [
      {
        effort: "ultra",
        description: "Maximum reasoning with automatic task delegation",
      },
      {
        effort: "future_effort",
        description: "A model-defined future effort",
        future_preset_field: true,
      },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    service_tiers: [{ id: "fast", name: "Fast", description: "Low latency" }],
    availability_nux: { message: "Available now" },
    upgrade: null,
    base_instructions: "You are Codex.",
    model_messages: {
      instructions_template: "{{ personality }}",
      instructions_variables: {
        personality_default: "",
        personality_friendly: "Friendly",
        personality_pragmatic: "Pragmatic",
      },
      approvals: null,
    },
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 372_000,
    max_context_window: 372_000,
    auto_compact_token_limit: null,
    comp_hash: "3000",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: true,
    auto_review_model_override: null,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    prefer_websockets: true,
    available_in_plans: ["plus", "pro"],
    future_top_level_field: { enabled: true },
    ...overrides,
  };
}

describe("ReasoningEffortSchema", () => {
  it("accepts known and future non-empty effort values as opaque strings", () => {
    expect(ReasoningEffortSchema.parse("ultra")).toBe("ultra");
    expect(ReasoningEffortSchema.parse("future_effort")).toBe("future_effort");
  });

  it("rejects empty reasoning effort values", () => {
    expect(() => ReasoningEffortSchema.parse("")).toThrow();
  });
});

describe("CodexModelInfoSchema", () => {
  it("parses current GPT-5.6 metadata and preserves unknown fields", () => {
    const parsed = CodexModelInfoSchema.parse(
      modelInfo({
        minimal_client_version: "0.144.0",
      }),
    );

    expect(parsed.slug).toBe("gpt-5.6-sol");
    expect(parsed.default_reasoning_level).toBe("ultra");
    expect(parsed.supported_reasoning_levels[1]?.effort).toBe("future_effort");
    expect(parsed.tool_mode).toBe("code_mode_only");
    expect(parsed.multi_agent_version).toBe("v2");
    expect(parsed.use_responses_lite).toBe(true);
    expect(parsed.minimal_client_version).toBe("0.144.0");
    expect(parsed.future_top_level_field).toEqual({ enabled: true });
    expect(parsed.supported_reasoning_levels[1]?.future_preset_field).toBe(true);
  });

  it("accepts the online Codex API client-version tuple", () => {
    const parsed = CodexModelInfoSchema.parse(
      modelInfo({
        minimal_client_version: [0, 144, 0],
      }),
    );

    expect(parsed.minimal_client_version).toEqual([0, 144, 0]);
  });

  it("applies the same backward-compatible defaults as Codex serde", () => {
    const parsed = CodexModelInfoSchema.parse(
      modelInfo({
        default_reasoning_level: undefined,
        additional_speed_tiers: undefined,
        service_tiers: undefined,
        default_service_tier: undefined,
        include_skills_usage_instructions: undefined,
        default_reasoning_summary: undefined,
        web_search_tool_type: undefined,
        supports_image_detail_original: undefined,
        effective_context_window_percent: undefined,
        input_modalities: undefined,
        supports_search_tool: undefined,
        use_responses_lite: undefined,
        tool_mode: undefined,
        multi_agent_version: undefined,
      }),
    );

    expect(parsed.additional_speed_tiers).toEqual([]);
    expect(parsed.service_tiers).toEqual([]);
    expect(parsed.include_skills_usage_instructions).toBe(false);
    expect(parsed.default_reasoning_summary).toBe("auto");
    expect(parsed.web_search_tool_type).toBe("text");
    expect(parsed.supports_image_detail_original).toBe(false);
    expect(parsed.effective_context_window_percent).toBe(95);
    expect(parsed.input_modalities).toEqual(["text", "image"]);
    expect(parsed.supports_search_tool).toBe(false);
    expect(parsed.use_responses_lite).toBe(false);
  });

  it("accepts audio in the Codex model input modalities", () => {
    const parsed = CodexModelInfoSchema.parse(
      modelInfo({ input_modalities: ["text", "image", "audio"] }),
    );

    expect(parsed.input_modalities).toEqual(["text", "image", "audio"]);
  });

  it("treats future tool selectors as omitted like Codex", () => {
    const parsed = CodexModelInfoSchema.parse(
      modelInfo({
        tool_mode: "future_tool_mode",
        multi_agent_version: "v3",
      }),
    );

    expect(parsed.tool_mode).toBeUndefined();
    expect(parsed.multi_agent_version).toBeUndefined();
  });

  it("rejects invalid critical fields", () => {
    expect(() => CodexModelInfoSchema.parse(modelInfo({ slug: "" }))).toThrow();
    expect(() => CodexModelInfoSchema.parse(modelInfo({ priority: 1.5 }))).toThrow();
    expect(() =>
      CodexModelInfoSchema.parse(modelInfo({ visibility: "future_visibility" })),
    ).toThrow();
    expect(() =>
      CodexModelInfoSchema.parse(
        modelInfo({
          supported_reasoning_levels: [{ effort: "", description: "invalid" }],
        }),
      ),
    ).toThrow();
  });
});

describe("CodexModelsResponseSchema", () => {
  it("parses the /models wrapper and preserves response metadata", () => {
    const parsed = CodexModelsResponseSchema.parse({
      models: [modelInfo()],
      future_response_field: "kept",
    });

    expect(parsed.models).toHaveLength(1);
    expect(parsed.future_response_field).toBe("kept");
  });
});
