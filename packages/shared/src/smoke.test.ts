import { describe, expect, it } from "vitest";
import { version } from "./version.js";

// Smoke test: proves the Vitest harness discovers and runs packages/**/*.test.ts
// and that a minimal pure function in @helm/shared is importable.

describe("vitest harness smoke test", () => {
  it("imports and runs a pure function from @helm/shared", () => {
    expect(version()).toBe("0.0.0");
  });
});
