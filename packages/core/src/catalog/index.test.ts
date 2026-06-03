import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CatalogEntrySchema, type GeneratedCatalog } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { CatalogError, loadCatalog } from "./index.js";

const generated: GeneratedCatalog = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  source: "litellm:model_prices_and_context_window.json",
  models: [
    {
      modelKey: "openai/gpt-4o",
      capabilities: {
        supportsTools: true,
        supportsJsonMode: true,
        supportsVision: false,
        supportsStreaming: true,
        maxContextTokens: 128_000,
        maxOutputTokens: 16_384,
      },
      pricing: { inputPerMTokUsd: 2.5, outputPerMTokUsd: 10 },
    },
  ],
};

describe("loadCatalog", () => {
  it("seeds entries from the generated catalog with source=generated", () => {
    const cat = loadCatalog({
      generated,
      capabilitiesOverride: {},
      pricingOverride: {},
    });
    const entry = cat.get("openai/gpt-4o");
    expect(entry?.source).toBe("generated");
    expect(entry?.capabilities.supportsVision).toBe(false);
    expect(entry?.pricing.inputPerMTokUsd).toBe(2.5);
  });

  it("lets a manual capability override win per-field and marks source=override", () => {
    const cat = loadCatalog({
      generated,
      capabilitiesOverride: { "openai/gpt-4o": { supportsVision: true } },
      pricingOverride: {},
    });
    const entry = cat.get("openai/gpt-4o");
    expect(entry?.capabilities.supportsVision).toBe(true); // overridden
    expect(entry?.capabilities.supportsTools).toBe(true); // untouched, from generated
    expect(entry?.source).toBe("override");
  });

  it("lets a manual pricing override replace generated pricing", () => {
    const cat = loadCatalog({
      generated,
      capabilitiesOverride: {},
      pricingOverride: { "openai/gpt-4o": { inputPerMTokUsd: 1.0 } },
    });
    const entry = cat.get("openai/gpt-4o");
    expect(entry?.pricing.inputPerMTokUsd).toBe(1.0); // overridden
    expect(entry?.pricing.outputPerMTokUsd).toBe(10); // untouched
    expect(entry?.source).toBe("override");
  });

  it("fail-closed on illegal override types (ConfigError, no value echo)", () => {
    expect(() =>
      loadCatalog({
        generated,
        capabilitiesOverride: { "openai/gpt-4o": { maxContextTokens: "big" } },
        pricingOverride: {},
      }),
    ).toThrow(CatalogError);
  });

  it("allows an override to introduce a brand-new modelKey (source=override)", () => {
    const cat = loadCatalog({
      generated,
      capabilitiesOverride: {
        "local/custom-model": { supportsTools: true, maxContextTokens: 8192 },
      },
      pricingOverride: {},
    });
    const entry = cat.get("local/custom-model");
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("override");
    expect(entry?.capabilities.supportsTools).toBe(true);
    expect(entry?.capabilities.supportsVision).toBe(false); // defaulted
  });

  it("propagates a requiresStreaming override into the merged catalog entry", () => {
    // A requiresStreaming override (capabilities.yaml) must survive the merge so the
    // executor's capability filter can read it (catalog.get(alias).capabilities).
    const cat = loadCatalog({
      generated,
      capabilitiesOverride: { "openai-codex/gpt-5.5": { requiresStreaming: true } },
      pricingOverride: {},
    });
    const entry = cat.get("openai-codex/gpt-5.5");
    expect(entry?.capabilities.requiresStreaming).toBe(true);
  });

  it("leaves requiresStreaming absent for entries that never set it (back-compat)", () => {
    const cat = loadCatalog({ generated, capabilitiesOverride: {}, pricingOverride: {} });
    expect(cat.get("openai/gpt-4o")?.capabilities.requiresStreaming).toBeUndefined();
  });

  it("re-validates every merged entry against CatalogEntrySchema (fail-closed on drift)", () => {
    // Exercise all three entry shapes: generated, capability-override-new,
    // pricing-override-new. The final merge pass must leave each conforming to
    // the schema (a brand-new override key must default EVERY required field).
    const cat = loadCatalog({
      generated,
      capabilitiesOverride: { "local/caps-only": { supportsTools: true } },
      pricingOverride: { "local/price-only": { inputPerMTokUsd: 1 } },
    });
    for (const entry of cat.values()) {
      expect(() => CatalogEntrySchema.parse(entry)).not.toThrow();
    }
    // The pricing-only new key must carry fully-defaulted capabilities (incl.
    // the nullable-but-required maxOutputTokens).
    const priceOnly = cat.get("local/price-only");
    expect(priceOnly?.capabilities.maxOutputTokens).toBeNull();
    expect(priceOnly?.capabilities.maxContextTokens).toBe(0);
  });
});

describe("catalog runtime path is network-free", () => {
  it("does not import http/fetch/network clients", () => {
    const src = readFileSync(join(__dirname, "index.ts"), "utf-8");
    expect(src).not.toMatch(/from\s+["']node:https?["']/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/import\s+.*\baxios\b/);
    // Must not import the build-time sync script into the runtime path.
    expect(src).not.toMatch(/sync-catalog/);
  });
});
