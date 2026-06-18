import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GeneratedCatalog, GeneratedCatalogEntry } from "@helm/shared";

// Build-time script: read LiteLLM's model_prices_and_context_window.json from a
// LOCAL snapshot → normalize → write a checked-in generated catalog. NEVER
// invoked at production runtime; only via `pnpm sync:catalog`. Lives under
// scripts/ (outside packages/core runtime) on purpose.

export interface SyncOptions {
  sourcePath: string; // local path to upstream model_prices_and_context_window.json
  outDir?: string; // default packages/core/src/catalog/generated/
  now?: () => Date; // injected for deterministic generatedAt in tests
}

interface UpstreamModelInfo {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  // Prompt-cache prices. DeepSeek publishes its cache-hit price under
  // input_cost_per_token_cache_hit instead of cache_read_input_token_cost.
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_cache_hit?: number;
  supports_function_calling?: boolean;
  supports_response_schema?: boolean;
  supports_vision?: boolean;
  mode?: string;
}

const DEFAULT_OUT_DIR = "packages/core/src/catalog/generated";

// Per-token USD → per-million-token USD; null when upstream omits it.
// Round to 6 decimals to strip IEEE-754 artifacts (e.g. 0.0000008 * 1e6 =
// 0.7999999999999999) so the checked-in artifact stays clean and diff-friendly.
function perMTok(perToken: number | undefined): number | null {
  if (typeof perToken !== "number" || Number.isNaN(perToken)) return null;
  return Math.round(perToken * 1_000_000 * 1e6) / 1e6;
}

function normalizeEntry(
  modelKey: string,
  info: UpstreamModelInfo,
): GeneratedCatalogEntry | null {
  // fail-closed at BUILD time: a model with no usable context window is skipped
  // (warn) rather than written as a half-baked entry.
  const maxContext = info.max_input_tokens ?? info.max_tokens;
  if (typeof maxContext !== "number" || maxContext <= 0) {
    return null;
  }
  return {
    modelKey,
    capabilities: {
      supportsTools: info.supports_function_calling === true,
      // LiteLLM's `supports_response_schema` IS the strict json_schema flag — map it to
      // the `schema` tier; absence means no JSON mode at all (`none`). LiteLLM exposes no
      // json_object-only signal, so the `object` tier comes only from manual overrides.
      jsonOutput: info.supports_response_schema === true ? "schema" : "none",
      supportsVision: info.supports_vision === true,
      // Chat/completion modes stream; embeddings etc. do not.
      supportsStreaming: info.mode === undefined || info.mode === "chat",
      maxContextTokens: maxContext,
      maxOutputTokens:
        typeof info.max_output_tokens === "number"
          ? info.max_output_tokens
          : null,
    },
    pricing: {
      inputPerMTokUsd: perMTok(info.input_cost_per_token),
      outputPerMTokUsd: perMTok(info.output_cost_per_token),
      // null = unpublished (consumer applies its heuristic), never coerced to 0.
      cacheReadPerMTokUsd: perMTok(
        info.cache_read_input_token_cost ?? info.input_cost_per_token_cache_hit,
      ),
      cacheWritePerMTokUsd: perMTok(info.cache_creation_input_token_cost),
    },
  };
}

export async function syncCatalog(
  opts: SyncOptions,
): Promise<{ modelCount: number; outFile: string }> {
  const now = opts.now ?? (() => new Date());
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;

  const rawText = readFileSync(opts.sourcePath, "utf-8");
  const upstream = JSON.parse(rawText) as Record<string, UpstreamModelInfo>;

  const models: GeneratedCatalogEntry[] = [];
  for (const [modelKey, info] of Object.entries(upstream)) {
    // LiteLLM ships a "sample_spec" pseudo-entry; never a real model.
    if (modelKey === "sample_spec") continue;
    if (info === null || typeof info !== "object") continue;
    const entry = normalizeEntry(modelKey, info);
    if (entry === null) {
      // eslint-disable-next-line no-console
      console.warn(`[sync:catalog] skipped ${modelKey}: no usable context window`);
      continue;
    }
    models.push(entry);
  }

  // Stable key order for a deterministic, diff-friendly checked-in artifact.
  models.sort((a, b) => a.modelKey.localeCompare(b.modelKey));

  const catalog: GeneratedCatalog = {
    generatedAt: now().toISOString(),
    source: "litellm:model_prices_and_context_window.json",
    models,
  };

  const outFile = join(outDir, "catalog.json");
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf-8");

  return { modelCount: models.length, outFile };
}

// CLI entry: `pnpm sync:catalog [sourcePath]`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const sourcePath =
    process.argv[2] ??
    join("scripts", "fixtures", "model_prices_and_context_window.json");
  syncCatalog({ sourcePath })
    .then(({ modelCount, outFile }) => {
      // eslint-disable-next-line no-console
      console.log(`[sync:catalog] wrote ${modelCount} models → ${outFile}`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[sync:catalog] failed:", err);
      process.exit(1);
    });
}
