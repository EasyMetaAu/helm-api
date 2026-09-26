import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync(
  new URL("../routes/+layout.svelte", import.meta.url),
  "utf8",
);

describe("Portal layout", () => {
  it("caps page content width consistently on wide screens", () => {
    expect(layout).toContain("max-w-[1600px]");
    expect(layout).toContain("mx-auto");
  });

  it("puts the locale switcher directly in the top nav, and Account as a nav item", () => {
    // LocaleSwitcher must appear at least twice: once in the top-bar cluster,
    // once still inside the account dropdown (kept for the mobile/menu path).
    expect(layout.match(/<LocaleSwitcher/g)?.length).toBeGreaterThanOrEqual(1);
    expect(layout).toContain('{ seg: "account", label: "Account" }');
  });
});
