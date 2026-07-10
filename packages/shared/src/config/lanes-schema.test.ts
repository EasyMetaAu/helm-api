import { describe, expect, it } from "vitest";
import { type LanesConfig, parseLanesConfig } from "./lanes-schema.js";

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

  it("fails closed when balanced is missing", () => {
    const raw = {
      economy: { primary: "cheap_model", fallback: ["premium"] },
      premium: { primary: "best_reasoning_model", fallback: [] },
    };
    expect(() => parseLanesConfig(raw)).toThrow(/balanced/);
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

  it("accepts an optional lane reasoning_effort from the strict effort enum", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const raw = { balanced: { primary: "x", reasoning_effort: effort } };
      const cfg = parseLanesConfig(raw);
      expect(cfg.balanced?.reasoning_effort).toBe(effort);
    }
  });

  it("omits reasoning_effort when absent (default lanes stay unforced)", () => {
    const cfg = parseLanesConfig(validRaw());
    expect(cfg.balanced?.reasoning_effort).toBeUndefined();
  });

  it("rejects an unknown reasoning_effort value (fail-closed, NOT normalized)", () => {
    for (const effort of ["ultra", "super"]) {
      const raw = { balanced: { primary: "x", reasoning_effort: effort } };
      expect(() => parseLanesConfig(raw)).toThrow();
    }
  });
});
