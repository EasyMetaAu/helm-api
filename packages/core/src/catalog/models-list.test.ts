import type { CatalogEntry } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { parseLanesConfig } from "../lanes/schema.js";
import { buildModelsList } from "./models-list.js";

// A small lane graph exercising: a plain lane, a lane that references ANOTHER
// lane in its fallback (nested expansion), and the required `balanced` terminal.
const lanes = parseLanesConfig({
  economy: { primary: "deepseek/flash", fallback: ["balanced"] },
  balanced: { primary: "deepseek/pro", fallback: [] },
  premium: { primary: "openai/o", fallback: ["balanced"] }, // nested -> deepseek/pro
});

function entry(modelKey: string, over: Partial<CatalogEntry["capabilities"]> = {}): CatalogEntry {
  return {
    modelKey,
    capabilities: {
      supportsTools: true,
      supportsJsonMode: true,
      supportsVision: false,
      supportsStreaming: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_000,
      ...over,
    },
    pricing: { inputPerMTokUsd: 0.5, outputPerMTokUsd: 1.5 },
    source: "override",
  };
}

const catalog = new Map<string, CatalogEntry>([
  ["deepseek/flash", entry("deepseek/flash")],
  ["deepseek/pro", entry("deepseek/pro")],
  ["openai/o", entry("openai/o", { supportsVision: true })],
]);

const providerAliases = ["deepseek/flash", "deepseek/pro", "openai/o"];

describe("buildModelsList", () => {
  it("normal key: lists lanes + auto only, no concrete aliases, no pricing leaked", () => {
    const list = buildModelsList({
      lanes,
      catalog,
      providerAliases,
      allowCustomModel: false,
    });

    expect(list.object).toBe("list");
    const ids = list.data.map((m) => m.id);
    // lanes (config order) then auto; NO provider aliases.
    expect(ids).toEqual(["economy", "balanced", "premium", "auto"]);

    for (const m of list.data) {
      expect(m.object).toBe("model");
      expect(m.type).toBe("lane");
      expect(m.owned_by).toBe("helm");
      // Principle 6 / 7: lanes never carry supply-chain pricing or capabilities.
      expect(m.pricing).toBeUndefined();
      expect(m.capabilities).toBeUndefined();
    }
    // A lane entry's membership is itself; `auto` carries none.
    expect(list.data.find((m) => m.id === "balanced")?.lanes).toEqual(["balanced"]);
    expect(list.data.find((m) => m.id === "auto")?.lanes).toBeUndefined();
  });

  it("allow_custom_model key: appends concrete aliases with capabilities/pricing + lane membership", () => {
    const list = buildModelsList({
      lanes,
      catalog,
      providerAliases,
      allowCustomModel: true,
    });

    const ids = list.data.map((m) => m.id);
    // lanes + auto, then aliases sorted alphabetically.
    expect(ids).toEqual([
      "economy",
      "balanced",
      "premium",
      "auto",
      "deepseek/flash",
      "deepseek/pro",
      "openai/o",
    ]);

    const pro = list.data.find((m) => m.id === "deepseek/pro");
    expect(pro?.type).toBe("model");
    expect(pro?.owned_by).toBe("deepseek");
    expect(pro?.capabilities?.maxContextTokens).toBe(128_000);
    expect(pro?.pricing?.inputPerMTokUsd).toBe(0.5);
    // deepseek/pro is balanced.primary AND the nested target of premium + economy.
    expect(pro?.lanes?.sort()).toEqual(["balanced", "economy", "premium"]);

    const flash = list.data.find((m) => m.id === "deepseek/flash");
    expect(flash?.lanes).toEqual(["economy"]);
  });

  it("nested lane references expand to leaf aliases for membership", () => {
    const list = buildModelsList({
      lanes,
      catalog,
      providerAliases,
      allowCustomModel: true,
    });
    // openai/o is premium.primary only (no other lane references it).
    expect(list.data.find((m) => m.id === "openai/o")?.lanes).toEqual(["premium"]);
  });

  it("respects allowedLanes: restricts visible lanes and membership", () => {
    const list = buildModelsList({
      lanes,
      catalog,
      providerAliases,
      allowCustomModel: true,
      allowedLanes: ["economy"],
    });
    const ids = list.data.map((m) => m.id);
    // Only the economy lane + auto are visible.
    expect(ids).toContain("economy");
    expect(ids).not.toContain("balanced");
    expect(ids).not.toContain("premium");
    expect(ids).toContain("auto");
    // economy expands to deepseek/flash -> deepseek/pro, so membership is economy-only.
    expect(list.data.find((m) => m.id === "deepseek/pro")?.lanes).toEqual(["economy"]);
  });

  it("an alias absent from the catalog still lists (no capabilities/pricing)", () => {
    const list = buildModelsList({
      lanes,
      catalog,
      providerAliases: [...providerAliases, "mystery/x"],
      allowCustomModel: true,
    });
    const mystery = list.data.find((m) => m.id === "mystery/x");
    expect(mystery?.type).toBe("model");
    expect(mystery?.capabilities).toBeUndefined();
    expect(mystery?.pricing).toBeUndefined();
    expect(mystery?.lanes).toEqual([]); // reachable only by explicit model
  });
});
