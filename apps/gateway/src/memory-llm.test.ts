import type { ProviderClient } from "@helm/core";
import type { Observation, RawMessage, Reflection } from "@helm/shared";
import { MemoryLlmSchema } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createMemoryLlmRuntime } from "./memory-llm.js";

function rawMessage(id: string, role: RawMessage["role"], content: string): RawMessage {
  return {
    id,
    threadId: "thread-1",
    role,
    content,
    tokenEstimate: Math.ceil(content.length / 4),
    createdAt: new Date(`2026-06-0${id.slice(-1)}T00:00:00Z`),
  };
}

function observation(id: string, text: string, observedAt: Date): Observation {
  return {
    id,
    threadId: "thread-1",
    sourceMessageRange: [`m-${id}-a`, `m-${id}-b`],
    observationText: text,
    observedAt,
    priority: 1,
    tags: ["project-alpha"],
    referenceCount: 0,
    importance: 0.5,
    status: "active",
    referencedAt: null,
    archivedAt: null,
    expiredAt: null,
  };
}

function reflection(): Reflection {
  return {
    id: "refl-1",
    projectId: "project-alpha",
    resourceId: null,
    threadId: null,
    reflectionText: "Previous stable reflection.",
    version: 1,
    tokenEstimate: 7,
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    referencedAt: null,
    referenceCount: 0,
    status: "active",
  };
}

function providerWithJson(json: unknown): ProviderClient & {
  chatCompletion: ReturnType<typeof vi.fn>;
} {
  const chatCompletion = vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify(json) } }],
  }));
  return {
    chatCompletion,
    async *chatCompletionStream() {
      // Memory LLM calls are non-streaming only.
    },
  };
}

function runtimeArgs(overrides: {
  response: unknown;
  resolveAlias?: string;
  providerModel?: string;
}) {
  const client = providerWithJson(overrides.response);
  const logs: Array<{ line: string; meta?: object }> = [];
  const resolveModel = vi.fn((alias: string) =>
    alias === (overrides.resolveAlias ?? "deepseek/memory-small")
      ? { client, providerModel: overrides.providerModel ?? "memory-small" }
      : null,
  );
  const runtime = createMemoryLlmRuntime({
    config: MemoryLlmSchema.parse({
      enabled: true,
      model: "deepseek/memory-small",
      observation_model: "openai/observer",
      facts_model: "openai/facts",
      timeout_ms: 1000,
      temperature: 0,
      max_tokens: { observation: 321, reflection: 654, facts: 987 },
    }),
    resolveModel,
    estimateTokens: (text) => Math.ceil(text.length / 4),
    log: (line, meta) => logs.push({ line, meta }),
  });
  return { runtime, client, resolveModel, logs };
}

describe("createMemoryLlmRuntime", () => {
  it("keeps deterministic summarization when memory.llm.enabled is false", async () => {
    const resolveModel = vi.fn();
    const runtime = createMemoryLlmRuntime({
      config: MemoryLlmSchema.parse({}),
      resolveModel,
      estimateTokens: (text) => Math.ceil(text.length / 4),
      log: vi.fn(),
    });

    const result = await runtime.summarize({
      messages: [
        rawMessage("m1", "user", "Remember that invoices must use PO #123."),
        rawMessage("m2", "assistant", "Got it."),
      ],
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(result.observationText).toContain("user: Remember that invoices must use PO #123.");
    expect(result.observationText).toContain("assistant: Got it.");
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("uses the configured observation_model for observer compaction and parses JSON", async () => {
    const { runtime, client, resolveModel } = runtimeArgs({
      response: {
        observation_text: "Invoices for Project Alpha require PO #123.",
        priority: 8,
        importance: 0.82,
        tags: ["project-alpha", "billing"],
      },
      resolveAlias: "openai/observer",
      providerModel: "gpt-observer",
    });

    const result = await runtime.summarize({
      messages: [rawMessage("m1", "user", "Project Alpha invoices require PO #123.")],
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(resolveModel).toHaveBeenCalledWith("openai/observer");
    expect(client.chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-observer",
        stream: false,
        temperature: 0,
        max_tokens: 321,
        response_format: { type: "json_object" },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      observationText: "Invoices for Project Alpha require PO #123.",
      priority: 8,
      importance: 0.82,
      tags: ["project-alpha", "billing"],
    });
  });

  it("accepts the observer's 0..10 priority scale so priority can derive salience above 0.5", async () => {
    const { runtime } = runtimeArgs({
      response: {
        observation_text: "The user strongly prefers bilingual explanations.",
        priority: 10,
        tags: ["preference"],
      },
      resolveAlias: "openai/observer",
    });

    const result = await runtime.summarize({
      messages: [rawMessage("m1", "user", "Always explain in English and Chinese.")],
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(result.priority).toBe(10);
    expect(result.importance).toBeUndefined();
  });

  it("falls back to deterministic observation text when the LLM returns whitespace-only text", async () => {
    const { runtime, logs } = runtimeArgs({
      response: { observation_text: "   " },
      resolveAlias: "openai/observer",
    });

    const result = await runtime.summarize({
      messages: [rawMessage("m1", "user", "Project Alpha invoices require PO #123.")],
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(result.observationText).toBe("user: Project Alpha invoices require PO #123.");
    expect(logs.some((l) => l.line === "memory.llm.fallback")).toBe(true);
  });

  it("falls back to deterministic reflection compaction when the LLM returns invalid JSON", async () => {
    const client: ProviderClient = {
      chatCompletion: vi.fn(async () => ({ choices: [{ message: { content: "not json" } }] })),
      async *chatCompletionStream() {},
    };
    const logs: Array<{ line: string; meta?: object }> = [];
    const runtime = createMemoryLlmRuntime({
      config: MemoryLlmSchema.parse({
        enabled: true,
        model: "deepseek/memory-small",
        timeout_ms: 1000,
      }),
      resolveModel: () => ({ client, providerModel: "memory-small" }),
      estimateTokens: (text) => Math.ceil(text.length / 4),
      log: (line, meta) => logs.push({ line, meta }),
    });
    const observations = [
      observation("obs-1", "User prefers concise English explanations.", new Date("2026-06-01")),
    ];

    const result = await runtime.merge({
      observations,
      previousReflection: reflection(),
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(result.reflectionText).toBe("- User prefers concise English explanations.");
    expect(result.tokenEstimate).toBe(Math.ceil(result.reflectionText.length / 4));
    expect(logs.some((l) => l.line === "memory.llm.fallback")).toBe(true);
  });

  it("does not send previous reflection text to the LLM merge prompt", async () => {
    const { runtime, client } = runtimeArgs({
      response: { reflection_text: "Only active observations should survive." },
    });

    await runtime.merge({
      observations: [
        observation("obs-1", "Active observation stays visible.", new Date("2026-06-01")),
      ],
      previousReflection: {
        ...reflection(),
        reflectionText: "FORGOTTEN_SECRET should never be available to the model.",
      },
      now: new Date("2026-06-09T00:00:00Z"),
    });

    const body = client.chatCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(JSON.stringify(body.messages)).not.toContain("FORGOTTEN_SECRET");
    expect(JSON.stringify(body.messages)).not.toContain("previous_reflection");
  });

  it("falls back to deterministic reflection text when the LLM returns whitespace-only text", async () => {
    const { runtime, logs } = runtimeArgs({
      response: { reflection_text: "   " },
    });
    const observations = [
      observation("obs-1", "User prefers concise English explanations.", new Date("2026-06-01")),
    ];

    const result = await runtime.merge({
      observations,
      previousReflection: reflection(),
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(result.reflectionText).toBe("- User prefers concise English explanations.");
    expect(logs.some((l) => l.line === "memory.llm.fallback")).toBe(true);
  });

  it("maps fact valid_from_observation_id back to the supporting observation timestamp and id range", async () => {
    const { runtime, client, resolveModel } = runtimeArgs({
      response: {
        facts: [
          {
            subject_text: "Project Alpha",
            fact_text: "Project Alpha invoices require PO #123.",
            valid_from_observation_id: "obs-2",
          },
        ],
      },
      resolveAlias: "openai/facts",
      providerModel: "gpt-facts",
    });
    const obs1At = new Date("2026-06-01T00:00:00Z");
    const obs2At = new Date("2026-06-02T00:00:00Z");

    const facts = await runtime.extractFacts({
      observations: [
        observation("obs-1", "Project Alpha uses Net 30.", obs1At),
        observation("obs-2", "Project Alpha invoices require PO #123.", obs2At),
      ],
      previousReflection: reflection(),
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(resolveModel).toHaveBeenCalledWith("openai/facts");
    expect(client.chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-facts", max_tokens: 987 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(facts).toEqual([
      {
        subjectText: "Project Alpha",
        factText: "Project Alpha invoices require PO #123.",
        validFrom: obs2At,
        sourceObservationRange: ["obs-2", "obs-2"],
      },
    ]);
  });

  it("does not send previous reflection text to the LLM fact-extraction prompt", async () => {
    const { runtime, client } = runtimeArgs({
      response: {
        facts: [
          {
            subject_text: "Project Alpha",
            fact_text: "Project Alpha invoices require PO #123.",
            valid_from_observation_id: "obs-1",
          },
        ],
      },
      resolveAlias: "openai/facts",
    });

    await runtime.extractFacts({
      observations: [
        observation("obs-1", "Project Alpha invoices require PO #123.", new Date("2026-06-01")),
      ],
      previousReflection: {
        ...reflection(),
        reflectionText: "FORGOTTEN_SECRET should never be available to fact extraction.",
      },
      now: new Date("2026-06-09T00:00:00Z"),
    });

    const body = client.chatCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(JSON.stringify(body.messages)).not.toContain("FORGOTTEN_SECRET");
    expect(JSON.stringify(body.messages)).not.toContain("previous_reflection");
  });

  it("falls back to deterministic facts when any LLM fact has a missing or invalid citation", async () => {
    const { runtime, logs } = runtimeArgs({
      response: {
        facts: [
          {
            subject_text: "Hallucinated",
            fact_text: "This fact has no valid supporting observation.",
            valid_from_observation_id: "obs-missing",
          },
        ],
      },
      resolveAlias: "openai/facts",
    });
    const obsAt = new Date("2026-06-01T00:00:00Z");

    const facts = await runtime.extractFacts({
      observations: [observation("obs-1", "Project Alpha invoices require PO #123.", obsAt)],
      previousReflection: null,
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(facts).toEqual([
      {
        subjectText: "project-alpha",
        factText: "Project Alpha invoices require PO #123.",
        validFrom: obsAt,
        sourceObservationRange: ["obs-1", "obs-1"],
      },
    ]);
    expect(logs.some((l) => l.line === "memory.llm.fact_citation_invalid")).toBe(true);
  });

  it("falls back to deterministic facts when an LLM fact omits valid_from_observation_id", async () => {
    const { runtime } = runtimeArgs({
      response: {
        facts: [{ subject_text: "Hallucinated", fact_text: "This fact has no citation." }],
      },
      resolveAlias: "openai/facts",
    });

    const facts = await runtime.extractFacts({
      observations: [
        observation("obs-1", "Project Alpha invoices require PO #123.", new Date("2026-06-01")),
      ],
      previousReflection: null,
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(facts[0]?.factText).toBe("Project Alpha invoices require PO #123.");
  });

  // Salient-fact fast path (salient-fact-memory-spec Change A): extract atomic
  // facts from RAW turns, decoupled from compaction. Unlike the observation-based
  // extractor, there is NO deterministic fallback — without an LLM there are no
  // eager facts (the config gate enforces llm.enabled), so the fallback is [].
  describe("extractFactsFromMessages (raw-message eager extraction)", () => {
    const NOW = new Date("2026-06-09T00:00:00Z");

    it("returns [] when memory.llm.enabled is false (no LLM ⇒ no eager facts)", async () => {
      const resolveModel = vi.fn();
      const runtime = createMemoryLlmRuntime({
        config: MemoryLlmSchema.parse({}),
        resolveModel,
        estimateTokens: (t) => Math.ceil(t.length / 4),
        log: vi.fn(),
      });
      const facts = await runtime.extractFactsFromMessages({
        messages: [rawMessage("m1", "user", "我喜欢的数字是42,你记住")],
        now: NOW,
      });
      expect(facts).toEqual([]);
      expect(resolveModel).not.toHaveBeenCalled();
    });

    it("extracts {subjectText, factText} from raw turns via facts_model, stamped validFrom=now", async () => {
      const { runtime, client, resolveModel } = runtimeArgs({
        response: {
          facts: [{ subject_text: "favorite number", fact_text: "The user's favorite number is 42." }],
        },
        resolveAlias: "openai/facts",
        providerModel: "gpt-facts",
      });

      const facts = await runtime.extractFactsFromMessages({
        messages: [
          rawMessage("m1", "user", "我喜欢的数字是42,你记住"),
          rawMessage("m2", "assistant", "记下了。"),
        ],
        now: NOW,
      });

      expect(resolveModel).toHaveBeenCalledWith("openai/facts");
      expect(client.chatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-facts", max_tokens: 987 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      // raw facts carry NO sourceObservationRange (there is no observation)
      expect(facts).toEqual([
        {
          subjectText: "favorite number",
          factText: "The user's favorite number is 42.",
          validFrom: NOW,
        },
      ]);
      // the raw user turn is sent to the model (not observations)
      const body = client.chatCompletion.mock.calls[0]?.[0] as {
        messages: Array<{ content: string }>;
      };
      expect(JSON.stringify(body.messages)).toContain("我喜欢的数字是42");
    });

    it("returns [] (fail-open) on invalid JSON", async () => {
      const client: ProviderClient = {
        chatCompletion: vi.fn(async () => ({ choices: [{ message: { content: "not json" } }] })),
        async *chatCompletionStream() {},
      };
      const logs: Array<{ line: string; meta?: object }> = [];
      const runtime = createMemoryLlmRuntime({
        config: MemoryLlmSchema.parse({ enabled: true, model: "deepseek/memory-small" }),
        resolveModel: () => ({ client, providerModel: "memory-small" }),
        estimateTokens: (t) => Math.ceil(t.length / 4),
        log: (line, meta) => logs.push({ line, meta }),
      });
      const facts = await runtime.extractFactsFromMessages({
        messages: [rawMessage("m1", "user", "I prefer dark mode.")],
        now: NOW,
      });
      expect(facts).toEqual([]);
      expect(logs.some((l) => l.line === "memory.llm.fallback")).toBe(true);
    });

    it("returns [] when the configured model is unavailable", async () => {
      const logs: Array<{ line: string; meta?: object }> = [];
      const runtime = createMemoryLlmRuntime({
        config: MemoryLlmSchema.parse({ enabled: true, model: "missing/model" }),
        resolveModel: () => null,
        estimateTokens: (t) => Math.ceil(t.length / 4),
        log: (line, meta) => logs.push({ line, meta }),
      });
      const facts = await runtime.extractFactsFromMessages({
        messages: [rawMessage("m1", "user", "I prefer dark mode.")],
        now: NOW,
      });
      expect(facts).toEqual([]);
      expect(logs.some((l) => l.line === "memory.llm.model_unavailable")).toBe(true);
    });
  });

  it("falls back to deterministic fact extraction when the configured model is unavailable", async () => {
    const logs: Array<{ line: string; meta?: object }> = [];
    const runtime = createMemoryLlmRuntime({
      config: MemoryLlmSchema.parse({ enabled: true, model: "missing/model" }),
      resolveModel: () => null,
      estimateTokens: (text) => Math.ceil(text.length / 4),
      log: (line, meta) => logs.push({ line, meta }),
    });

    const facts = await runtime.extractFacts({
      observations: [
        observation("obs-1", "Project Alpha invoices require PO #123.", new Date("2026-06-01")),
      ],
      previousReflection: null,
      now: new Date("2026-06-09T00:00:00Z"),
    });

    expect(facts[0]).toMatchObject({
      subjectText: "project-alpha",
      factText: "Project Alpha invoices require PO #123.",
      sourceObservationRange: ["obs-1", "obs-1"],
    });
    expect(logs.some((l) => l.line === "memory.llm.model_unavailable")).toBe(true);
  });
});
