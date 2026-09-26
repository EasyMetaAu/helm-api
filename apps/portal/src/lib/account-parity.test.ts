import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../routes/account/+page.svelte", import.meta.url),
  "utf8",
);

describe("Portal account page", () => {
  it("constrains width and lays out key details as a 2-column description list", () => {
    expect(page).toContain("max-w-3xl");
    expect(page).toContain("<dl");
    expect(page).toContain("grid-cols-2");
  });

  it("shows budgets as used / limit with a progress bar, backed by real usage data", () => {
    expect(page).toContain("getUsage");
    expect(page).toContain("progress-track");
    expect(page).toContain("progress-bar");
    expect(page).toContain("me.budget.spend_usd");
    expect(page).toContain("me.budget.tokens");
  });
});
