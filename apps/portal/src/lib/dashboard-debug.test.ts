import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const page = readFileSync(
  new URL("../routes/+page.svelte", import.meta.url),
  "utf8",
);

it("second stat row matches the first portal row and shows separate model token counts", () => {
  // Same grid and card typography as the first stat row on this page.
  expect(page).toContain('<div class="grid grid-cols-2 gap-3 md:grid-cols-4">');
  expect(page).toContain('<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">');
  for (const field of [
    "error_count",
    "ok_count",
    "avg_latency_ms",
    "avg_tps",
    "cache_hit_rate",
    "cached_tokens",
  ]) {
    expect(page).toContain(`stats.totals.${field}`);
  }
  for (const label of ["Input tokens", "Output tokens"]) {
    expect(page).toMatch(
      new RegExp(
        `<td\\s+data-label=\\{\\$t\\("${label}"\\)\\}\\s+class="table-mode:text-right tabular-nums"`,
      ),
    );
  }
  expect(page).toContain("formatTokens(row.input)");
  expect(page).toContain("formatTokens(row.output)");
});
