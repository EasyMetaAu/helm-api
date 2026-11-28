import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  filtersToSearch,
  parseFilters,
  requestDetailHref,
  requestsBackTo,
} from "./requests-filters";

describe("request debug filters", () => {
  it("restores lane, decision source and exact session text from the list URL", () => {
    const search =
      "range=7d&lane=balanced&decided_by=fallback&session=QA+%2F+Test&page=2";
    const filters = parseFilters(new URLSearchParams(search));
    expect(filters).toMatchObject({
      range: "7d",
      page: 2,
      lane: "balanced",
      decidedBy: "fallback",
      session: "QA / Test",
    });
    expect(filtersToSearch(filters)).toBe(search);
    expect(
      parseFilters(new URLSearchParams("decided_by=invalid")).decidedBy,
    ).toBeUndefined();
  });

  it("returns to the full list URL from a detail link and ignores another origin", () => {
    const list = "/portal/requests";
    const from = list + "?lane=fast&page=2";
    const url = new URL(
      requestDetailHref(list, "r/1", from),
      "https://example.test",
    );
    expect(url.pathname).toBe(list + "/r%2F1");
    expect(requestsBackTo(url.searchParams.get("from"), list)).toBe(from);
    expect(requestsBackTo("//bad.example/portal/requests", list)).toBe(list);
  });

  it("uses admin request table cells and filter controls", () => {
    const page = readFileSync(
      new URL("../routes/requests/+page.svelte", import.meta.url),
      "utf8",
    );
    for (const id of [
      "filter-lane",
      "filter-decided-by",
      "filter-session",
      "find-by-trace",
      "decided-by",
      "cell-tps",
    ]) {
      expect(page).toContain(`data-testid="${id}"`);
    }
    expect(page).toContain('class="badge-fallback"');
    expect(page).toContain("title={sessionLabel}");
  });
});
