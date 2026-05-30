import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeneratedCatalogSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { syncCatalog } from "./sync-catalog.js";

const UPSTREAM_SAMPLE = {
  sample_spec: { max_tokens: 1, mode: "chat" }, // pseudo-entry, must be skipped
  "gpt-4o": {
    max_input_tokens: 128000,
    max_output_tokens: 16384,
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    supports_function_calling: true,
    supports_response_schema: true,
    supports_vision: true,
    mode: "chat",
  },
  "claude-3-5-sonnet": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    supports_function_calling: true,
    supports_vision: true,
    mode: "chat",
  },
  "broken-no-context": {
    input_cost_per_token: 0.001, // no context window → skipped (fail-closed at build)
  },
};

function setup(): { sourcePath: string; outDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "helm-catalog-"));
  const sourcePath = join(dir, "upstream.json");
  writeFileSync(sourcePath, JSON.stringify(UPSTREAM_SAMPLE), "utf-8");
  return { sourcePath, outDir: join(dir, "generated") };
}

describe("syncCatalog", () => {
  it("normalizes upstream JSON into a valid generated catalog", async () => {
    const { sourcePath, outDir } = setup();
    const { modelCount, outFile } = await syncCatalog({
      sourcePath,
      outDir,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    // 2 valid models (gpt-4o, claude); sample_spec + broken entry skipped.
    expect(modelCount).toBe(2);

    const written = JSON.parse(readFileSync(outFile, "utf-8"));
    const parsed = GeneratedCatalogSchema.parse(written);
    expect(parsed.generatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(parsed.models).toHaveLength(2);

    const byKey = new Map(parsed.models.map((m) => [m.modelKey, m]));
    const gpt = byKey.get("gpt-4o");
    expect(gpt?.capabilities.maxContextTokens).toBe(128000);
    expect(gpt?.capabilities.maxOutputTokens).toBe(16384);
    expect(gpt?.capabilities.supportsTools).toBe(true);
    expect(gpt?.capabilities.supportsVision).toBe(true);
    // per-token → per-MTok USD
    expect(gpt?.pricing.inputPerMTokUsd).toBeCloseTo(2.5, 6);
    expect(gpt?.pricing.outputPerMTokUsd).toBeCloseTo(10, 6);
  });

  it("emits models in stable sorted key order (deterministic artifact)", async () => {
    const { sourcePath, outDir } = setup();
    const { outFile } = await syncCatalog({
      sourcePath,
      outDir,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    const parsed = JSON.parse(readFileSync(outFile, "utf-8"));
    const keys = parsed.models.map((m: { modelKey: string }) => m.modelKey);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });
});
