import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

describe("loadRuntimeCatalog", () => {
  it("loads the checked-in generated catalog with no overrides (absent yamls)", () => {
    // readFile that throws for every override file → both treated as absent.
    const catalog = loadRuntimeCatalog({
      configDir: "/cfg",
      readFile: reader(() => {
        throw new Error("ENOENT");
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
        throw new Error("ENOENT");
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
            "  supportsJsonMode: false",
            "  supportsVision: false",
            "  supportsStreaming: true",
            "  maxContextTokens: 131072",
            "  maxOutputTokens: 4096",
            "",
          ].join("\n");
        }
        throw new Error("ENOENT");
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

  it("fails closed on an invalid override yaml (principle 2)", () => {
    expect(() =>
      loadRuntimeCatalog({
        configDir: "/cfg",
        readFile: reader((p) => {
          if (p.endsWith("capabilities.yaml")) {
            // supportsTools must be a boolean → schema rejects.
            return '"x/y":\n  supportsTools: "yes"\n';
          }
          throw new Error("ENOENT");
        }),
      }),
    ).toThrow(CatalogError);
  });
});
