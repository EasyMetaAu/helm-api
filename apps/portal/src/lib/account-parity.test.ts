import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../routes/account/+page.svelte", import.meta.url),
  "utf8",
);

describe("Portal account page", () => {
  it("fills the window and lays out key details as a 2-column description list", () => {
    expect(page).not.toContain("max-w-3xl");
    expect(page).toContain("<dl");
    // Label column hugs its text, value column takes the rest and may shrink, so
    // a long value wraps by words instead of orphaning characters on phones.
    expect(page).toContain("grid-cols-[auto_minmax(0,1fr)]");
    // The cards go two-up from tablets and three-up on wide screens, so a
    // full-width page never stretches a label away from its value.
    expect(page).toContain("md:grid-cols-2");
    expect(page).toContain("xl:grid-cols-3");
  });

  it("shows budgets as used / limit with a progress bar, backed by real usage data", () => {
    expect(page).toContain("getUsage");
    expect(page).toContain("progress-track");
    expect(page).toContain("progress-bar");
    expect(page).toContain("me.budget.spend_usd");
    expect(page).toContain("me.budget.tokens");
  });
});
