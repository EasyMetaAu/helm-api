import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { resolveCostUsd } from "./cost.js";
import { CatalogError } from "./index.js";
import { loadRuntimeCatalog } from "./load.js";

// loadRuntimeCatalog wires the checked-in generated catalog (supply-chain input)
// with the two manual override yamls (capabilities.yaml / pricing.yaml) and
// returns the merged Map<modelKey, CatalogEntry> the capability filter consumes.
// IO is injectable (readFile) so these tests control the OVERRIDE yamls while
// reading the REAL checked-in generated catalog from disk (it ships in-repo).

// Read the real generated catalog for any generated/catalog.json path; let the
// per-test fn drive the override yamls. `over` throws → that override is absent.
function reader(over: (path: string) => string): (path: string) => string {
  return (path) => {
    if (path.endsWith("catalog.json")) return readFileSync(path, "utf8");
    return over(path);
  };
}

// An absent OPTIONAL override is signalled by an ENOENT throw (fs.readFileSync's
// behaviour for a missing file); only `code === 'ENOENT'` is treated as absent.
function enoent(): never {
  throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
}

describe("loadRuntimeCatalog", () => {
  it("loads the checked-in generated catalog with no overrides (absent yamls)", () => {
    // readFile that throws for every override file → both treated as absent.
    const catalog = loadRuntimeCatalog({
      configDir: "/cfg",
      readFile: reader(() => {
        enoent();
      }),
    });
    // The generated catalog ships known model keys — at least one real entry.
    expect(catalog.size).toBeGreaterThan(0);
    const haiku = catalog.get("claude-3-5-haiku-20241022");
    expect(haiku).toBeDefined();
    expect(haiku?.capabilities.supportsTools).toBe(true);
    expect(haiku?.source).toBe("generated");
  });

  it("applies a capabilities.yaml override per-field (manual wins)", () => {
    const catalog = loadRuntimeCatalog({
      configDir: "/cfg",
      readFile: reader((p) => {
        if (p.endsWith("capabilities.yaml")) {
          // claude-3-5-haiku is generated with supportsVision:false — flip it.
          return '"claude-3-5-haiku-20241022":\n  supportsVision: true\n';
        }
        enoent();
      }),
    });
    const haiku = catalog.get("claude-3-5-haiku-20241022");
    expect(haiku?.capabilities.supportsVision).toBe(true);
    // Untouched generated fields fall through.
    expect(haiku?.capabilities.supportsTools).toBe(true);
    expect(haiku?.source).toBe("override");
  });

  it("registers a brand-new model from capabilities.yaml not in the generated set", () => {
    const catalog = loadRuntimeCatalog({
      configDir: "/cfg",
      readFile: reader((p) => {
        if (p.endsWith("capabilities.yaml")) {
          return [
            '"local/llama-3.1-70b":',
            "  supportsTools: true",
            "  jsonOutput: none",
            "  supportsVision: false",
            "  supportsStreaming: true",
            "  maxContextTokens: 131072",
            "  maxOutputTokens: 4096",
            "",
          ].join("\n");
        }
        enoent();
      }),
    });
    const local = catalog.get("local/llama-3.1-70b");
    expect(local).toBeDefined();
    expect(local?.capabilities.maxContextTokens).toBe(131072);
    expect(local?.source).toBe("override");
  });

  it("loads the REAL repo config/ end-to-end (the production default path)", () => {
    // No injection — exercise the exact call buildServer makes against the
    // checked-in config/. This is the integration proof that the wiring works
    // with the real generated catalog + real (commented-out) override yamls.
    const catalog = loadRuntimeCatalog({ configDir: "config" });
    expect(catalog.size).toBeGreaterThan(0);
    // A known generated model carries populated capabilities the filter reads.
    const gpt4o = catalog.get("gpt-4o");
    expect(gpt4o?.capabilities.supportsVision).toBe(true);
  });

  it("loads the native Claude Fable pricing and capabilities from real config", () => {
    const catalog = loadRuntimeCatalog({ configDir: "config" });
    const latest = catalog.get("anthropic/claude-fable-5-1");
    const fable = catalog.get("anthropic/claude-fable-5");

    expect(latest?.source).toBe("override");
    expect(latest?.pricing).toMatchObject({
      inputPerMTokUsd: 10,
      outputPerMTokUsd: 50,
      cacheReadPerMTokUsd: 0.25,
      cacheWritePerMTokUsd: 12.5,
      cacheWrite1hPerMTokUsd: 20,
    });
    expect(latest?.capabilities.maxContextTokens).toBe(1_000_000);
    expect(latest?.capabilities.maxOutputTokens).toBe(128_000);

    expect(fable?.source).toBe("override");
    expect(fable?.pricing).toMatchObject({
      inputPerMTokUsd: 10,
      outputPerMTokUsd: 50,
      cacheReadPerMTokUsd: 1,
      cacheWritePerMTokUsd: 12.5,
    });
    expect(fable?.capabilities.maxContextTokens).toBe(1_000_000);
    expect(fable?.capabilities.supportsStreaming).toBe(true);
  });

  it("loads complete native Claude Sonnet 5 pricing and capabilities from real config", () => {
    const catalog = loadRuntimeCatalog({ configDir: "config" });
    const sonnet = catalog.get("anthropic/claude-sonnet-5");

    expect(sonnet?.source).toBe("override");
    expect(sonnet?.pricing).toEqual({
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 10,
      cacheReadPerMTokUsd: 0.2,
      cacheWritePerMTokUsd: 2.5,
      cacheWrite1hPerMTokUsd: 4,
      inferenceGeoMultipliers: { global: 1, us: 1.1 },
    });
    expect(sonnet?.capabilities).toMatchObject({
      supportsTools: true,
      jsonOutput: "schema",
      supportsVision: true,
      supportsStreaming: true,
      reasoningEffort: {
        anthropicOutputConfig: {
          supported: true,
          levels: ["low", "medium", "high", "xhigh", "max"],
          map: { minimal: "low" },
        },
        anthropicThinking: {
          supported: false,
        },
      },
      modalities: ["document"],
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(
      resolveCostUsd(sonnet?.pricing, {
        usage: {
          input_tokens: 600,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 100,
          output_tokens: 200,
        },
      }),
    ).toBeCloseTo((600 * 2 + 300 * 0.2 + 100 * 2.5 + 200 * 10) / 1_000_000, 12);
  });

  it("loads verified xAI capabilities with public-API-equivalent Grok pricing", () => {
    const catalog = loadRuntimeCatalog({ configDir: "config" });
    const grok45 = catalog.get("xai/grok-4.5");
    const grok46 = catalog.get("xai/grok-4.6");
    const composer = catalog.get("xai/grok-composer-2.5-fast");

    expect(grok45?.capabilities).toMatchObject({
      supportsTools: true,
      jsonOutput: "none",
      supportsVision: true,
      supportsStreaming: true,
      maxContextTokens: 500_000,
      maxOutputTokens: null,
      reasoningEffort: {
        openaiReasoning: { supported: true, levels: ["low", "medium", "high"] },
      },
    });
    expect(composer?.capabilities).toMatchObject({
      supportsTools: true,
      jsonOutput: "none",
      supportsVision: false,
      supportsStreaming: true,
      maxContextTokens: 200_000,
      maxOutputTokens: null,
      reasoningEffort: {
        openaiReasoning: { supported: false },
      },
    });
    expect(grok46?.capabilities).toMatchObject({
      supportsTools: true,
      jsonOutput: "none",
      supportsVision: true,
      supportsStreaming: true,
      maxContextTokens: 500_000,
      maxOutputTokens: null,
      reasoningEffort: {
        openaiReasoning: { supported: true, levels: ["low", "medium", "high"] },
      },
    });
    // SuperGrok itself is flat-fee. These are explicitly API-equivalent telemetry
    // and budget estimates, while Composer stays unpriced because it has no verified rate.
    expect(grok45?.pricing).toEqual({
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 6,
      cacheReadPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: null,
      serviceTiers: {
        priority: {
          inputPerMTokUsd: 4,
          cacheReadPerMTokUsd: 1,
          outputPerMTokUsd: 12,
        },
      },
    });
    expect(grok46?.pricing).toEqual({
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 6,
      cacheReadPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: null,
      contextTiers: [
        {
          minPromptTokens: 200_000,
          inputPerMTokUsd: 4,
          outputPerMTokUsd: 12,
          cacheReadPerMTokUsd: 1,
        },
      ],
      serviceTiers: {
        priority: {
          inputPerMTokUsd: 4,
          cacheReadPerMTokUsd: 1,
          outputPerMTokUsd: 12,
          contextTiers: [
            {
              minPromptTokens: 200_000,
              inputPerMTokUsd: 8,
              outputPerMTokUsd: 24,
              cacheReadPerMTokUsd: 2,
            },
          ],
        },
      },
    });
    expect(composer?.pricing).toEqual({
      inputPerMTokUsd: null,
      outputPerMTokUsd: null,
      cacheReadPerMTokUsd: null,
      cacheWritePerMTokUsd: null,
    });
    expect(
      resolveCostUsd(grok45?.pricing, {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 4 },
        },
      }),
    ).toBeCloseTo((6 * 2 + 4 * 0.5 + 5 * 6) / 1_000_000, 12);
  });

  it("loads current official cache and context-tier prices for routed models", () => {
    const catalog = loadRuntimeCatalog({ configDir: "config" });

    expect(catalog.get("deepseek/deepseek-v4-flash")?.pricing).toMatchObject({
      inputPerMTokUsd: 0.14,
      outputPerMTokUsd: 0.28,
      cacheReadPerMTokUsd: 0.0028,
    });
    expect(catalog.get("deepseek/deepseek-v4-pro")?.pricing.cacheReadPerMTokUsd).toBe(0.003625);
    expect(catalog.get("openai-codex/gpt-5.4-mini")?.pricing.cacheReadPerMTokUsd).toBe(0.075);
    expect(catalog.get("openai-codex/gpt-image-2")).toMatchObject({
      capabilities: { outputImage: true },
      pricing: { inputPerMTokUsd: null, outputPerMTokUsd: null },
    });
    expect(catalog.get("zenmux-vertex/gemini-3.5-flash")?.pricing.cacheReadPerMTokUsd).toBe(0.15);
    expect(catalog.get("zenmux-vertex/gemini-3.5-flash")?.pricing.serviceTiers).toEqual({
      flex: {
        inputPerMTokUsd: 0.75,
        outputPerMTokUsd: 4.5,
        cacheReadPerMTokUsd: 0.08,
      },
      priority: {
        inputPerMTokUsd: 2.7,
        outputPerMTokUsd: 16.2,
        cacheReadPerMTokUsd: 0.27,
      },
    });
    expect(catalog.get("zenmux-vertex/gemini-3.1-flash-lite")?.pricing.serviceTiers).toEqual({
      flex: {
        inputPerMTokUsd: 0.125,
        outputPerMTokUsd: 0.75,
        cacheReadPerMTokUsd: 0.0125,
        audioInputPerMTokUsd: 0.25,
        audioCacheReadPerMTokUsd: 0.025,
      },
      priority: {
        inputPerMTokUsd: 0.45,
        outputPerMTokUsd: 2.7,
        cacheReadPerMTokUsd: 0.045,
        audioInputPerMTokUsd: 0.9,
        audioCacheReadPerMTokUsd: 0.09,
      },
    });
    expect(catalog.get("openai-codex/gpt-5.6-sol")?.pricing.contextTiers).toEqual([
      expect.objectContaining({
        minPromptTokens: 272_001,
        inputPerMTokUsd: 10,
        outputPerMTokUsd: 45,
      }),
    ]);
    expect(catalog.get("openai-codex/gpt-5.5")?.pricing.contextTiers).toEqual([
      expect.objectContaining({
        minPromptTokens: 272_001,
        inputPerMTokUsd: 10,
        outputPerMTokUsd: 45,
        cacheReadPerMTokUsd: 1,
      }),
    ]);
    expect(catalog.get("openai-codex/gpt-5.4")?.pricing.contextTiers).toEqual([
      expect.objectContaining({
        minPromptTokens: 272_001,
        inputPerMTokUsd: 5,
        outputPerMTokUsd: 22.5,
        cacheReadPerMTokUsd: 0.5,
      }),
    ]);
    expect(catalog.get("anthropic/claude-opus-4-8")?.pricing.serviceTiers?.fast).toEqual({
      inputPerMTokUsd: 10,
      outputPerMTokUsd: 50,
      cacheReadPerMTokUsd: 1,
      cacheWritePerMTokUsd: 12.5,
      cacheWrite1hPerMTokUsd: 20,
    });
    for (const alias of [
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-fable-5",
    ]) {
      expect(catalog.get(alias)?.pricing.inferenceGeoMultipliers).toEqual({ global: 1, us: 1.1 });
    }
    expect(
      catalog.get("anthropic/claude-haiku-4-5-20251001")?.pricing.inferenceGeoMultipliers,
    ).toBeUndefined();
    expect(
      catalog.get("zenmux-anthropic/claude-opus-4.8")?.pricing.inferenceGeoMultipliers,
    ).toBeUndefined();
    expect(catalog.get("zenmux-vertex/gemini-3.1-pro")?.pricing.contextTiers).toEqual([
      expect.objectContaining({
        minPromptTokens: 200_001,
        inputPerMTokUsd: 4,
        outputPerMTokUsd: 18,
      }),
    ]);
    expect(catalog.get("zenmux-vertex/gemini-3.1-pro")?.pricing.serviceTiers).toEqual({
      flex: {
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 6,
        cacheReadPerMTokUsd: 0.2,
        contextTiers: [
          {
            minPromptTokens: 200_001,
            inputPerMTokUsd: 2,
            outputPerMTokUsd: 9,
            cacheReadPerMTokUsd: 0.4,
          },
        ],
      },
      priority: {
        inputPerMTokUsd: 3.6,
        outputPerMTokUsd: 21.6,
        cacheReadPerMTokUsd: 0.36,
        contextTiers: [
          {
            minPromptTokens: 200_001,
            inputPerMTokUsd: 7.2,
            outputPerMTokUsd: 32.4,
            cacheReadPerMTokUsd: 0.72,
          },
        ],
      },
    });
    expect(catalog.get("gemini-3.1-flash-image")?.pricing.serviceTiers).toBeUndefined();
    expect(catalog.get("google/gemini-3.1-flash-image")?.pricing.serviceTiers).toBeUndefined();
    expect(catalog.get("gemini-3-pro-image")?.pricing.serviceTiers).toEqual(
      catalog.get("google/gemini-3-pro-image")?.pricing.serviceTiers,
    );
    expect(catalog.get("gemini-3-pro-image")?.pricing.serviceTiers).toEqual({
      flex: {
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 6,
        imageOutputPerMTokUsd: 60,
      },
      priority: {
        inputPerMTokUsd: 3.6,
        outputPerMTokUsd: 21.6,
        imageOutputPerMTokUsd: 216,
      },
    });

    const geminiProPricing = catalog.get("zenmux-vertex/gemini-3.1-pro")?.pricing;
    expect(
      resolveCostUsd(geminiProPricing, {
        service_tier: "priority",
        usage: { prompt_tokens: 200_001, completion_tokens: 100 },
      }),
    ).toBeCloseTo((200_001 * 7.2 + 100 * 32.4) / 1_000_000, 12);

    const flashLitePricing = catalog.get("zenmux-vertex/gemini-3.1-flash-lite")?.pricing;
    expect(
      resolveCostUsd(flashLitePricing, {
        service_tier: "flex",
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          prompt_tokens_details: {
            cached_tokens: 200,
            audio_tokens: 400,
            cached_audio_tokens: 100,
          },
        },
      }),
    ).toBeCloseTo(
      (500 * 0.125 + 300 * 0.25 + 100 * 0.0125 + 100 * 0.025 + 100 * 0.75) / 1_000_000,
      12,
    );
  });

  it("keeps dynamic auto-route estimates unknown instead of assigning a fake fixed price", () => {
    const catalog = loadRuntimeCatalog({ configDir: "config" });
    for (const alias of ["zenmux/auto", "openrouter/auto"]) {
      expect(catalog.get(alias)?.pricing.inputPerMTokUsd).toBeNull();
      expect(catalog.get(alias)?.pricing.outputPerMTokUsd).toBeNull();
    }
  });

  it("keeps every manually configured production alias covered by an explicit pricing decision", () => {
    const capabilities = parseYaml(readFileSync("config/capabilities.yaml", "utf8")) as Record<
      string,
      unknown
    >;
    const pricing = parseYaml(readFileSync("config/pricing.yaml", "utf8")) as Record<
      string,
      unknown
    >;
    const catalog = loadRuntimeCatalog({ configDir: "config" });

    // Subscription-only media aliases may intentionally omit a pricing row when
    // the remote operator has no trustworthy rate card for that alias.
    const intentionallyUnpriced = new Set([
      "openai-codex/gpt-image-2",
      "xai/grok-imagine-image",
      "xai/grok-imagine-image-quality",
      "xai/grok-imagine-video-1.5-preview",
      "xai/grok-imagine-video",
      "xai/grok-composer-2.5-fast",
      "gpt-image-2",
      "zenmux/auto",
      "openrouter/auto",
    ]);
    expect(
      Object.keys(capabilities).filter(
        (alias) => !(alias in pricing) && !intentionallyUnpriced.has(alias),
      ),
    ).toEqual([]);
    // Price-only keys are dynamic Codex auto-review plus the bare Layer-2 eval
    // model id (which bypasses the provider registry).
    expect(
      Object.keys(pricing)
        .filter((alias) => !(alias in capabilities))
        .sort(),
    ).toEqual(["deepseek-v4-flash", "openai-codex/codex-auto-review"]);
    const unexpectedUnpriced = Object.keys(capabilities).filter((alias) => {
      const rates = catalog.get(alias)?.pricing;
      return (
        !intentionallyUnpriced.has(alias) &&
        (rates?.inputPerMTokUsd == null || rates.outputPerMTokUsd == null)
      );
    });
    expect(unexpectedUnpriced).toEqual([]);
    expect(catalog.get("openai-codex/codex-auto-review")?.pricing).toMatchObject({
      inputPerMTokUsd: null,
      outputPerMTokUsd: null,
    });
  });

  it("fails closed on an invalid override yaml (principle 2)", () => {
    expect(() =>
      loadRuntimeCatalog({
        configDir: "/cfg",
        readFile: reader((p) => {
          if (p.endsWith("capabilities.yaml")) {
            // supportsTools must be a boolean → schema rejects.
            return '"x/y":\n  supportsTools: "yes"\n';
          }
          enoent();
        }),
      }),
    ).toThrow(CatalogError);
  });

  it("fails closed when context pricing tiers are not strictly ascending", () => {
    expect(() =>
      loadRuntimeCatalog({
        configDir: "/cfg",
        readFile: reader((p) => {
          if (p.endsWith("pricing.yaml")) {
            return [
              '"openai/gpt":',
              "  contextTiers:",
              "    - minPromptTokens: 300000",
              "      inputPerMTokUsd: 10",
              "      outputPerMTokUsd: 45",
              "    - minPromptTokens: 200000",
              "      inputPerMTokUsd: 5",
              "      outputPerMTokUsd: 22.5",
              "",
            ].join("\n");
          }
          enoent();
        }),
      }),
    ).toThrow(CatalogError);
  });

  it("fails CLOSED on a stale `supportsJsonMode` override key (jsonOutput migration)", () => {
    // The capability boolean was replaced by the `jsonOutput` tier. A `.strict()`
    // override schema must REJECT a leftover `supportsJsonMode` rather than silently
    // strip it (which would degrade a manually-JSON-capable alias to jsonOutput:"none"
    // and skip it for JSON requests). Fail-closed → operator migrates the key.
    expect(() =>
      loadRuntimeCatalog({
        configDir: "/cfg",
        readFile: reader((p) => {
          if (p.endsWith("capabilities.yaml")) {
            return '"deepseek/deepseek-v4-flash":\n  supportsJsonMode: true\n';
          }
          enoent();
        }),
      }),
    ).toThrow(CatalogError);
  });

  it("fails CLOSED when an override read throws a NON-ENOENT error (EACCES etc.)", () => {
    // EACCES/EIO/broken-symlink must NOT be swallowed as "absent": that would
    // silently wipe relay-model capabilities+pricing (they live ONLY in the
    // override layer) — a principle-2 fail-closed inversion.
    expect(() =>
      loadRuntimeCatalog({
        configDir: "/cfg",
        readFile: reader((p) => {
          if (p.endsWith("capabilities.yaml")) {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
          enoent();
        }),
      }),
    ).toThrow(CatalogError);
  });

  it("re-throws an error with no .code as fail-closed (not treated as absent)", () => {
    expect(() =>
      loadRuntimeCatalog({
        configDir: "/cfg",
        readFile: reader((p) => {
          if (p.endsWith("pricing.yaml")) {
            throw new Error("unexpected reader failure");
          }
          enoent();
        }),
      }),
    ).toThrow(CatalogError);
  });

  it("emits a structured 'catalog.override_absent' log per absent override (wrong-CWD observability)", () => {
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    loadRuntimeCatalog({
      configDir: "/cfg",
      readFile: reader(() => enoent()),
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
    });
    const absent = logs.filter((l) => l.msg === "catalog.override_absent");
    expect(absent).toHaveLength(2); // capabilities.yaml + pricing.yaml
    const files = absent.map((l) => l.fields?.file);
    expect(files.some((f) => String(f).endsWith("capabilities.yaml"))).toBe(true);
    expect(files.some((f) => String(f).endsWith("pricing.yaml"))).toBe(true);
  });
});
