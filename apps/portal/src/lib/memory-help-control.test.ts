import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../routes/memory/+page.svelte", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

function cssRule(selector: string): string {
  return (
    css.match(new RegExp(`\\.${selector}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? ""
  );
}

describe("Memory contextual-help control", () => {
  it("exposes its expanded state and applies a persistent open style", () => {
    expect(page).toContain('class="btn-help"');
    expect(page).toContain("aria-expanded={showInfo}");
    expect(page).toContain("class:btn-help-open={showInfo}");
  });

  it("has a dedicated circular resting treatment instead of the transparent generic icon", () => {
    const resting = cssRule("btn-help");
    const open = cssRule("btn-help-open");

    expect(resting).toContain("rounded-full");
    expect(resting).toContain("border-slate-200");
    expect(resting).toContain("bg-slate-100");
    expect(resting).toContain("font-semibold");
    expect(resting).toContain("focus-visible:ring-2");
    expect(open).toContain("bg-slate-200");
    expect(open).toContain("text-slate-800");
  });
});
