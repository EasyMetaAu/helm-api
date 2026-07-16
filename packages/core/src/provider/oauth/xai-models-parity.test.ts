import { describe, expect, it, vi } from "vitest";
import { listXaiOAuthModels } from "./models.js";

function catalog(data: unknown[]): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data }));
}

describe("xAI OAuth model parser — grok-build parity", () => {
  it("rejects a zero context window, accepts snake_case context, and falls back from model to id", async () => {
    const fetchImpl = catalog([
      { model: "zero-context", apiBackend: "responses", contextWindow: 0 },
      { model: "snake-context", api_backend: "responses", context_window: 131_072 },
      { model: "model-only", apiBackend: "responses" },
    ]);

    await expect(listXaiOAuthModels("access", fetchImpl)).resolves.toEqual([
      expect.objectContaining({
        id: "snake-context",
        model: "snake-context",
        contextWindow: 131_072,
      }),
      expect.objectContaining({
        id: "model-only",
        model: "model-only",
        contextWindow: 256_000,
      }),
    ]);
  });

  it("uses last-wins values for duplicate ids without moving their first insertion position", async () => {
    const fetchImpl = catalog([
      {
        id: "duplicate",
        model: "first-wire",
        name: "First",
        apiBackend: "responses",
      },
      { id: "stable", model: "stable-wire", apiBackend: "responses" },
      {
        id: "duplicate",
        model: "second-wire",
        name: "Second",
        apiBackend: "responses",
      },
    ]);

    const models = await listXaiOAuthModels("access", fetchImpl);

    expect(models.map((model) => model.id)).toEqual(["duplicate", "stable"]);
    expect(models[0]).toMatchObject({ model: "second-wire", name: "Second" });
  });

  it("normalizes max to xhigh for the scalar and selectable reasoning options", async () => {
    const fetchImpl = catalog([
      {
        model: "reasoning",
        apiBackend: "responses",
        reasoningEffort: "max",
        reasoningEfforts: ["max", { id: "deep", value: "max", label: "Deep" }],
      },
    ]);

    await expect(listXaiOAuthModels("access", fetchImpl)).resolves.toEqual([
      expect.objectContaining({
        reasoningEffort: "xhigh",
        reasoningEfforts: [
          { id: "xhigh", value: "xhigh", label: "Xhigh" },
          { id: "deep", value: "xhigh", label: "Deep" },
        ],
      }),
    ]);
  });

  it("falls through invalid camelCase reasoning fields to snake_case and _meta", async () => {
    const fetchImpl = catalog([
      {
        model: "snake-fallback",
        apiBackend: "responses",
        reasoningEffort: 42,
        reasoning_effort: "max",
        reasoningEfforts: {},
        reasoning_efforts: ["low"],
      },
      {
        model: "meta-fallback",
        apiBackend: "responses",
        reasoningEffort: false,
        reasoning_effort: 42,
        reasoningEfforts: "invalid",
        reasoning_efforts: {},
        _meta: { reasoningEffort: "high", reasoningEfforts: ["medium"] },
      },
    ]);

    const models = await listXaiOAuthModels("access", fetchImpl);

    expect(models[0]).toMatchObject({
      reasoningEffort: "xhigh",
      reasoningEfforts: [{ id: "low", value: "low", label: "Low" }],
    });
    expect(models[1]).toMatchObject({
      reasoningEffort: "high",
      reasoningEfforts: [{ id: "medium", value: "medium", label: "Medium" }],
    });
  });

  it("keeps u32 maxima and drops overflowing maxCompletionTokens and maxRetries", async () => {
    const fetchImpl = catalog([
      {
        model: "u32-max",
        apiBackend: "responses",
        maxCompletionTokens: 4_294_967_295,
        maxRetries: 4_294_967_295,
      },
      {
        model: "u32-overflow",
        apiBackend: "responses",
        maxCompletionTokens: 4_294_967_296,
        maxRetries: 4_294_967_296,
      },
    ]);

    const models = await listXaiOAuthModels("access", fetchImpl);

    expect(models[0]).toMatchObject({
      maxCompletionTokens: 4_294_967_295,
      maxRetries: 4_294_967_295,
    });
    expect(models[1]).not.toHaveProperty("maxCompletionTokens");
    expect(models[1]).not.toHaveProperty("maxRetries");
  });
});
