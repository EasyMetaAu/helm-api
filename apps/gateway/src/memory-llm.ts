import type { ExtractedFact, ObserverDeps, ProviderClient, ReflectorDeps } from "@helm/core";
import type { MemoryLlmConfig, Observation, RawMessage, Reflection } from "@helm/shared";
import { z } from "zod";

const MEMORY_SUMMARY_MAX_CHARS = 2000;
const MEMORY_REFLECTION_MAX_CHARS = 4000;

const ObservationOutputSchema = z.object({
  observation_text: z.string().trim().min(1),
  // Matches runObserverJob's priority/10 salience derivation.
  priority: z.number().int().min(0).max(10).optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
});

const ReflectionOutputSchema = z.object({
  reflection_text: z.string().trim().min(1),
});

const FactOutputSchema = z.object({
  subject_text: z.string().trim().min(1),
  fact_text: z.string().trim().min(1),
  valid_from_observation_id: z.string().trim().min(1),
});

// Some memory models (observed in prod: deepseek-v4-flash) ignore the {facts:[...]}
// envelope and return a BARE ARRAY of fact objects. Coerce that into the envelope
// BEFORE validation so a correct-but-unwrapped response is never silently dropped to
// the empty fallback — the exact failure mode that made eager facts never persist
// (the schema rejected the array, callJsonModel fell back to {facts:[]}). Mirrors the
// project's tolerant-passthrough rule: accept + normalize a valid response, never reject
// on shape alone.
function coerceFactsEnvelope(value: unknown): unknown {
  return Array.isArray(value) ? { facts: value } : value;
}

const FactsOutputSchema = z.preprocess(
  coerceFactsEnvelope,
  z.object({ facts: z.array(FactOutputSchema).default([]) }),
);

// Salient-fact fast path (Change A): facts extracted from RAW turns have no
// supporting observation to cite, so the output is just {subject_text, fact_text}.
const RawFactOutputSchema = z.object({
  subject_text: z.string().trim().min(1),
  fact_text: z.string().trim().min(1),
});
const RawFactsOutputSchema = z.preprocess(
  coerceFactsEnvelope,
  z.object({ facts: z.array(RawFactOutputSchema).default([]) }),
);

type ObservationOutput = z.infer<typeof ObservationOutputSchema>;
type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;
type FactsOutput = z.infer<typeof FactsOutputSchema>;
type RawFactsOutput = z.infer<typeof RawFactsOutputSchema>;

export interface MemoryModelResolution {
  client: ProviderClient;
  providerModel: string;
}

export interface CreateMemoryLlmRuntimeDeps {
  config: MemoryLlmConfig;
  resolveModel: (alias: string) => MemoryModelResolution | null;
  estimateTokens: (text: string) => number;
  log: (line: string, meta?: object) => void;
}

export interface MemoryLlmRuntime {
  summarize: ObserverDeps["summarize"];
  merge: ReflectorDeps["merge"];
  extractFacts: NonNullable<ReflectorDeps["extractFacts"]>;
  // Salient-fact fast path (Change A): raw-turns → atomic facts.
  extractFactsFromMessages: NonNullable<ObserverDeps["extractFactsFromMessages"]>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}

export function summarizeMessagesDeterministic(messages: readonly RawMessage[]): string {
  const body = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  return truncate(body || "(no messages)", MEMORY_SUMMARY_MAX_CHARS);
}

export function mergeObservationsDeterministic(
  observations: readonly Observation[],
  _previousReflection: Reflection | null,
): string {
  const body = observations.map((o) => `- ${o.observationText}`).join("\n");
  return truncate(body || "(no observations)", MEMORY_REFLECTION_MAX_CHARS);
}

export function extractFactsDeterministic(observations: readonly Observation[]): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  for (const o of observations) {
    const text = o.observationText.trim();
    if (text.length === 0 || text === "[pruned]") continue;
    const subjectText = o.tags?.[0]?.trim() || text.split(/\s+/).slice(0, 6).join(" ") || "general";
    facts.push({
      subjectText,
      factText: truncate(text, MEMORY_REFLECTION_MAX_CHARS),
      validFrom: o.observedAt,
      sourceObservationRange: [o.id, o.id],
    });
  }
  return facts;
}

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].slice(
    0,
    16,
  );
  return cleaned.length > 0 ? cleaned : undefined;
}

function assistantTextFromCompletion(response: Record<string, unknown>): string {
  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const message = choice.message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object") {
              const p = part as Record<string, unknown>;
              if (typeof p.text === "string") return p.text;
              if (typeof p.content === "string") return p.content;
            }
            return "";
          })
          .join("");
      }
    }
  }
  const outputText = response.output_text;
  return typeof outputText === "string" ? outputText : "";
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty LLM response");
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch (err) {
    // Salvage the first balanced JSON value out of noisy prose — an object {...} OR a
    // bare array [...] (some models wrap a top-level array in explanatory text). Prefer
    // whichever delimiter opens first so "[...] note: {...}" salvages the array.
    const objStart = candidate.indexOf("{");
    const objEnd = candidate.lastIndexOf("}");
    const arrStart = candidate.indexOf("[");
    const arrEnd = candidate.lastIndexOf("]");
    const objOk = objStart >= 0 && objEnd > objStart;
    const arrOk = arrStart >= 0 && arrEnd > arrStart;
    if (objOk && (!arrOk || objStart < arrStart)) {
      return JSON.parse(candidate.slice(objStart, objEnd + 1));
    }
    if (arrOk) return JSON.parse(candidate.slice(arrStart, arrEnd + 1));
    throw err;
  }
}

function safeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function taskModel(config: MemoryLlmConfig, task: "observation" | "reflection" | "facts") {
  switch (task) {
    case "observation":
      return config.observation_model ?? config.model;
    case "reflection":
      return config.reflection_model ?? config.model;
    case "facts":
      return config.facts_model ?? config.model;
  }
}

async function callJsonModel<T>(args: {
  deps: CreateMemoryLlmRuntimeDeps;
  task: "observation" | "reflection" | "facts";
  maxTokens: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
  schema: z.ZodType<T>;
  fallback: () => T;
}): Promise<T> {
  const { deps, task, maxTokens, messages, schema, fallback } = args;
  if (deps.config.enabled !== true) return fallback();
  const modelAlias = taskModel(deps.config, task);
  if (!modelAlias) return fallback();

  const resolved = deps.resolveModel(modelAlias);
  if (!resolved) {
    deps.log("memory.llm.model_unavailable", { task, model_alias: modelAlias });
    return fallback();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.config.timeout_ms);
  try {
    const response = await resolved.client.chatCompletion(
      {
        model: resolved.providerModel,
        messages,
        temperature: deps.config.temperature,
        stream: false,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      },
      { signal: controller.signal },
    );
    const text = assistantTextFromCompletion(response);
    const parsed = schema.parse(parseJsonObject(text));
    deps.log("memory.llm.completed", { task, model_alias: modelAlias });
    return parsed;
  } catch (err) {
    deps.log("memory.llm.fallback", {
      task,
      model_alias: modelAlias,
      error: safeError(err),
    });
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}

function observationPrompt(input: { messages: RawMessage[]; now: Date }) {
  return [
    {
      role: "system" as const,
      content:
        "Compress conversation turns into one durable memory observation. Return strict JSON only.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        now: input.now.toISOString(),
        schema: {
          observation_text: "string, one concise durable memory",
          priority: "integer 0..10, optional",
          importance: "number 0..1, optional",
          tags: ["short lowercase tags, optional"],
        },
        messages: input.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          created_at: m.createdAt.toISOString(),
        })),
      }),
    },
  ];
}

function reflectionPrompt(input: { observations: Observation[]; now: Date }) {
  return [
    {
      role: "system" as const,
      content:
        "Merge active memory observations into a stable, non-duplicative reflection. Return strict JSON only.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        now: input.now.toISOString(),
        schema: { reflection_text: "string, concise stable reflection" },
        observations: input.observations.map((o) => ({
          id: o.id,
          observed_at: o.observedAt.toISOString(),
          text: o.observationText,
          tags: o.tags ?? [],
        })),
      }),
    },
  ];
}

function factsPrompt(input: { observations: Observation[]; now: Date }) {
  return [
    {
      role: "system" as const,
      content: "Extract atomic, durable facts from memory observations. Return strict JSON only.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        now: input.now.toISOString(),
        schema: {
          facts: [
            {
              subject_text: "topic string",
              fact_text: "atomic assertion string",
              valid_from_observation_id: "id of the supporting observation",
            },
          ],
        },
        observations: input.observations.map((o) => ({
          id: o.id,
          observed_at: o.observedAt.toISOString(),
          text: o.observationText,
          tags: o.tags ?? [],
        })),
      }),
    },
  ];
}

function factsFromMessagesPrompt(input: { messages: RawMessage[]; now: Date }) {
  return [
    {
      role: "system" as const,
      content:
        "Extract durable, atomic facts the USER stated about themselves — preferences, " +
        "identity, stable instructions — that are worth remembering across future sessions. " +
        "Ignore transient task details, questions, and assistant text. If nothing durable was " +
        "stated, return an empty list. Return strict JSON only.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        now: input.now.toISOString(),
        schema: {
          facts: [
            {
              subject_text: "stable topic for supersede, e.g. 'favorite number'",
              fact_text: 'the atomic assertion, e.g. "The user\'s favorite number is 42."',
            },
          ],
        },
        messages: input.messages.map((m) => ({
          role: m.role,
          content: m.content,
          created_at: m.createdAt.toISOString(),
        })),
      }),
    },
  ];
}

export function createMemoryLlmRuntime(deps: CreateMemoryLlmRuntimeDeps): MemoryLlmRuntime {
  return {
    summarize: async (input) => {
      const parsed = await callJsonModel<ObservationOutput>({
        deps,
        task: "observation",
        maxTokens: deps.config.max_tokens.observation,
        messages: observationPrompt(input),
        schema: ObservationOutputSchema,
        fallback: () => ({ observation_text: summarizeMessagesDeterministic(input.messages) }),
      });
      const tags = cleanTags(parsed.tags);
      return {
        observationText: parsed.observation_text.trim(),
        ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
        ...(parsed.importance !== undefined ? { importance: parsed.importance } : {}),
        ...(tags !== undefined ? { tags } : {}),
      };
    },
    merge: async (input) => {
      const parsed = await callJsonModel<ReflectionOutput>({
        deps,
        task: "reflection",
        maxTokens: deps.config.max_tokens.reflection,
        messages: reflectionPrompt({ observations: input.observations, now: input.now }),
        schema: ReflectionOutputSchema,
        fallback: () => ({
          reflection_text: mergeObservationsDeterministic(
            input.observations,
            input.previousReflection,
          ),
        }),
      });
      const reflectionText = parsed.reflection_text.trim();
      return { reflectionText, tokenEstimate: deps.estimateTokens(reflectionText) };
    },
    extractFacts: async (input) => {
      const parsed = await callJsonModel<FactsOutput>({
        deps,
        task: "facts",
        maxTokens: deps.config.max_tokens.facts,
        messages: factsPrompt({ observations: input.observations, now: input.now }),
        schema: FactsOutputSchema,
        fallback: () => ({
          facts: extractFactsDeterministic(input.observations).flatMap((fact) => {
            const sourceObservationId = fact.sourceObservationRange?.[0];
            if (sourceObservationId === undefined) return [];
            return [
              {
                subject_text: fact.subjectText,
                fact_text: fact.factText,
                valid_from_observation_id: sourceObservationId,
              },
            ];
          }),
        }),
      });
      const byObservationId = new Map(input.observations.map((o) => [o.id, o]));
      const invalidCitation = parsed.facts.find(
        (fact) => !byObservationId.has(fact.valid_from_observation_id),
      );
      if (invalidCitation !== undefined) {
        deps.log("memory.llm.fact_citation_invalid", {
          observation_id: invalidCitation.valid_from_observation_id,
        });
        return extractFactsDeterministic(input.observations);
      }
      return parsed.facts.map((fact): ExtractedFact => {
        const supporting = byObservationId.get(fact.valid_from_observation_id);
        if (supporting === undefined) {
          // Guarded above; keep the type invariant explicit.
          throw new Error("memory LLM fact citation disappeared");
        }
        return {
          subjectText: fact.subject_text,
          factText: fact.fact_text,
          validFrom: supporting.observedAt,
          sourceObservationRange: [supporting.id, supporting.id],
        };
      });
    },
    extractFactsFromMessages: async (input) => {
      // No deterministic fallback: without an LLM there are no eager facts (the
      // config gate enforces llm.enabled). callJsonModel returns the fallback ([])
      // when disabled / model unavailable / parse fails — fail-open.
      const parsed = await callJsonModel<RawFactsOutput>({
        deps,
        task: "facts",
        maxTokens: deps.config.max_tokens.facts,
        messages: factsFromMessagesPrompt(input),
        schema: RawFactsOutputSchema,
        fallback: () => ({ facts: [] }),
      });
      // Raw facts have no supporting observation; validFrom is the processing time
      // (monotonic across observer runs, so a later restatement supersedes — the
      // store's `valid_from < new.valid_from` predicate). No sourceObservationRange.
      return parsed.facts.map(
        (fact): ExtractedFact => ({
          subjectText: fact.subject_text,
          factText: fact.fact_text,
          validFrom: input.now,
        }),
      );
    },
  };
}
