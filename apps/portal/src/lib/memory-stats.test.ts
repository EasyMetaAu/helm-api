import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { formatLatestTimestamp, formatTimestamp } from "./format";

const page = readFileSync(
  new URL("../routes/memory/+page.svelte", import.meta.url),
  "utf8",
);

it("shows the latest activity in local time and handles an empty activity history", () => {
  expect(
    formatLatestTimestamp([
      "2026-11-28T23:30:00+02:00",
      null,
      "2026-11-28T22:00:00Z",
      "2026-11-27T21:00:00Z",
    ]),
  ).toBe(formatTimestamp("2026-11-28T22:00:00Z"));
  expect(formatLatestTimestamp([null, null])).toBe("—");
});

it("uses the admin memory stat cards and omits unsupported statistics", () => {
  expect(page).toContain('data-testid="memory-stats"');
  expect(page).toContain('class="card flex flex-col gap-2"');
  expect(page).toContain("stats.storage.activeFacts");
  expect(page).toContain("stats.storage.activeReflections");
  expect(page).toContain("stats.storage.messages");
  expect(page).toContain("stats.queue.staleRunning");
  expect(page).toContain('class="badge-warning"');
  expect(page).toMatch(
    /status === 503 &&\s+\w+\.code === "memory_unavailable"/,
  );
});
