import { describe, expect, it } from "vitest";
import { DEFAULT_LANES, type LanesConfig, LanesConfigSchema, parseLanesConfig } from "./schema.js";

// A minimal-but-valid lanes.yaml object mirroring config/lanes.yaml defaults.
function validRaw(): unknown {
  return {
    economy: { purpose: "Cheap", primary: "cheap_model", fallback: ["balanced"] },
    balanced: {
      purpose: "Default",
      primary: "default_good_model",
      fallback: ["premium", "economy"],
    },
    premium: {
      purpose: "Strong",
      primary: "best_reasoning_model",
      fallback: ["balanced"],
    },
  };
}

describe("parseLanesConfig", () => {
  it("parses a valid config and preserves declared fallback order", () => {
    const cfg: LanesConfig = parseLanesConfig(validRaw());
    const balanced = cfg.balanced;
    if (!balanced) throw new Error("balanced lane must exist");
    expect(balanced.primary).toBe("default_good_model");
    // declaration order is NOT reordered
    expect(balanced.fallback).toEqual(["premium", "economy"]);
  });

  it("allows balanced to be absent when runtime.default_lane points elsewhere", () => {
    const raw = {
      economy: { primary: "cheap_model", fallback: ["premium"] },
      premium: { primary: "best_reasoning_model", fallback: [] },
    };
    expect(Object.keys(parseLanesConfig(raw))).toEqual(["economy", "premium"]);
  });

  it("fails closed when no lanes are configured", () => {
    expect(() => parseLanesConfig({})).toThrow();
  });

  it("fills defaults: missing constraints -> {} with false flags; missing fallback -> []", () => {
    const raw = {
      balanced: { primary: "default_good_model" },
    };
    const cfg = parseLanesConfig(raw);
    const balanced = cfg.balanced;
    if (!balanced) throw new Error("balanced lane must exist");
    expect(balanced.fallback).toEqual([]);
    expect(balanced.constraints.require_tools).toBe(false);
    expect(balanced.constraints.require_json).toBe(false);
    expect(balanced.constraints.require_vision).toBe(false);
  });

  it("rejects unknown fields on a lane (strict)", () => {
    const raw = {
      balanced: { primary: "default_good_model", weight: 5 },
    };
    expect(() => parseLanesConfig(raw)).toThrow();
  });

  it("rejects unknown fields on constraints (strict)", () => {
    const raw = {
      balanced: {
        primary: "default_good_model",
        constraints: { require_tools: true, bogus: 1 },
      },
    };
    expect(() => parseLanesConfig(raw)).toThrow();
  });

  it("accepts a config with only the three default lanes (task lanes optional)", () => {
    expect(() => parseLanesConfig(validRaw())).not.toThrow();
  });

  it("accepts optional task lanes referencing other lane names", () => {
    const raw = {
      ...(validRaw() as object),
      coding: {
        primary: "coding_model",
        fallback: ["premium", "balanced"],
        constraints: { require_tools: true },
      },
    };
    const cfg = parseLanesConfig(raw);
    expect(cfg.coding?.constraints.require_tools).toBe(true);
    expect(cfg.coding?.fallback).toEqual(["premium", "balanced"]);
  });

  it("throws on null / non-object / array input (fail-closed)", () => {
    expect(() => parseLanesConfig(null)).toThrow();
    expect(() => parseLanesConfig([])).toThrow();
    expect(() => parseLanesConfig("nope")).toThrow();
  });

  it("rejects empty primary string", () => {
    const raw = { balanced: { primary: "" } };
    expect(() => parseLanesConfig(raw)).toThrow();
  });

  it("rejects empty fallback element", () => {
    const raw = { balanced: { primary: "x", fallback: [""] } };
    expect(() => parseLanesConfig(raw)).toThrow();
  });
});

describe("DEFAULT_LANES", () => {
  it("is self-consistent: re-parses cleanly through its own schema", () => {
    expect(() => LanesConfigSchema.parse(DEFAULT_LANES)).not.toThrow();
  });

  it("contains the balanced terminal lane", () => {
    expect("balanced" in DEFAULT_LANES).toBe(true);
    expect(DEFAULT_LANES.balanced.fallback).toEqual(["premium", "economy"]);
  });

  it("defines economy / balanced / premium matching docs/04", () => {
    expect(DEFAULT_LANES.economy.primary).toBe("cheap_model");
    expect(DEFAULT_LANES.balanced.primary).toBe("default_good_model");
    expect(DEFAULT_LANES.premium.primary).toBe("best_reasoning_model");
    expect(DEFAULT_LANES.economy.fallback).toEqual(["balanced"]);
    expect(DEFAULT_LANES.premium.fallback).toEqual(["balanced"]);
  });
});
