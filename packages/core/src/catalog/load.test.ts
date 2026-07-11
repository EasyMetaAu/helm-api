import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    const fable = catalog.get("anthropic/claude-fable-5");

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
