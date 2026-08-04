import type { OAuthUsageBucket } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { aggregateByCalendar } from "./usage-calendar.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

function bucket(
  bucketMs: number,
  tokens: number,
  requests = 1,
  costUsd: number | null = null,
): OAuthUsageBucket {
  return { bucketMs, requests, tokens, costUsd };
}

describe("aggregateByCalendar", () => {
  // UTC-anchored (tzOffset 0) so day boundaries are UTC midnight.
  const D0 = Date.UTC(2026, 7, 1, 0); // 2026-08-01 00:00 UTC (a day floor)

  it("groups hour buckets into natural DAYS (local tz), most recent first", () => {
    const buckets = [
      bucket(D0 + 1 * HOUR, 100),
      bucket(D0 + 5 * HOUR, 200), // same day
      bucket(D0 + 1 * DAY + 2 * HOUR, 50), // next day
    ];
    const out = aggregateByCalendar(buckets, 0, "day");
    expect(out).toHaveLength(2);
    // newest first
    expect(out[0]).toMatchObject({
      periodStartMs: D0 + DAY,
      periodEndMs: D0 + 2 * DAY,
      tokens: 50,
    });
    expect(out[1]).toMatchObject({
      periodStartMs: D0,
      periodEndMs: D0 + DAY,
      tokens: 300,
      requests: 2,
    });
  });

  it("shifts day boundaries by the local tz offset", () => {
    // UTC+8 (480 min). A bucket at 2026-08-01 20:00 UTC is 2026-08-02 04:00 local → the
    // LOCAL day is 2026-08-02, whose start is 2026-08-01 16:00 UTC.
    const b = bucket(Date.UTC(2026, 7, 1, 20), 999);
    const out = aggregateByCalendar([b], 480, "day");
    expect(out).toHaveLength(1);
    // local-day start = 2026-08-01 16:00 UTC
    expect(out[0]?.periodStartMs).toBe(Date.UTC(2026, 7, 1, 16));
    expect(out[0]?.periodEndMs).toBe(Date.UTC(2026, 7, 2, 16));
  });

  it("groups into natural WEEKS (Monday start) local tz", () => {
    // 2026-08-01 is a Saturday. Its ISO week (Mon-Sun) starts 2026-07-27 (Mon).
    const sat = Date.UTC(2026, 7, 1, 12);
    const nextMon = Date.UTC(2026, 7, 3, 12); // 2026-08-03 is Monday → next week
    const out = aggregateByCalendar([bucket(sat, 100), bucket(nextMon, 40)], 0, "week");
    expect(out).toHaveLength(2);
    // newest first: week starting 2026-08-03 (Mon)
    expect(out[0]?.periodStartMs).toBe(Date.UTC(2026, 7, 3));
    expect(out[0]?.periodEndMs).toBe(Date.UTC(2026, 7, 10));
    // older: week starting 2026-07-27 (Mon)
    expect(out[1]?.periodStartMs).toBe(Date.UTC(2026, 6, 27));
    expect(out[1]?.tokens).toBe(100);
  });

  it("null-aware cost: all-null → null, any priced → numeric sum", () => {
    const day = [
      bucket(D0 + HOUR, 10, 1, null),
      bucket(D0 + 2 * HOUR, 10, 1, 1.5),
      bucket(D0 + 3 * HOUR, 10, 1, 2.5),
    ];
    expect(aggregateByCalendar(day, 0, "day")[0]?.costUsd).toBe(4);
    const allNull = [bucket(D0 + HOUR, 10, 1, null), bucket(D0 + 2 * HOUR, 10, 1, null)];
    expect(aggregateByCalendar(allNull, 0, "day")[0]?.costUsd).toBeNull();
  });

  it("returns [] for no buckets", () => {
    expect(aggregateByCalendar([], 0, "day")).toEqual([]);
  });
});
