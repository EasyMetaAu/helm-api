import { describe, expect, it } from "vitest";
import { StatsQuerySchema } from "./stats-query.js";

// The schema parses an untrusted querystring (Hono's c.req.query() → all strings).
// It must be fail-open: defaults applied, junk swallowed, never throws (principle 3).

describe("StatsQuerySchema", () => {
  it("applies defaults on an empty query", () => {
    const q = StatsQuerySchema.parse({});
    expect(q.start).toBeUndefined();
    expect(q.end).toBeUndefined();
    expect(q.bucket).toBe("day");
    expect(q.tzOffsetMinutes).toBe(0);
    expect(q.key_id).toBeUndefined();
  });

  it("parses key_id (detail-page key scope) and treats empty as unset", () => {
    expect(StatsQuerySchema.parse({ key_id: "  key_abc  " }).key_id).toBe("key_abc");
    expect(StatsQuerySchema.parse({ key_id: "" }).key_id).toBeUndefined();
  });

  it("coerces string scalars (querystring values are always strings)", () => {
    const q = StatsQuerySchema.parse({ start: "1000", end: "2000", bucket: "hour" });
    expect(q.start).toBe(1000);
    expect(q.end).toBe(2000);
    expect(q.bucket).toBe("hour");
  });

  it("parses a valid east/west tz offset in minutes", () => {
    expect(StatsQuerySchema.parse({ tzOffsetMinutes: "480" }).tzOffsetMinutes).toBe(480); // UTC+8
    expect(StatsQuerySchema.parse({ tzOffsetMinutes: "-300" }).tzOffsetMinutes).toBe(-300); // UTC-5
    expect(StatsQuerySchema.parse({ tzOffsetMinutes: "330" }).tzOffsetMinutes).toBe(330); // UTC+5:30
    expect(StatsQuerySchema.parse({ tzOffsetMinutes: "0" }).tzOffsetMinutes).toBe(0);
  });

  it("fails open to 0 on junk / fractional / out-of-range offset (never throws)", () => {
    expect(StatsQuerySchema.parse({ tzOffsetMinutes: "abc" }).tzOffsetMinutes).toBe(0);
    expect(StatsQuerySchema.parse({ tzOffsetMinutes: "480.5" }).tzOffsetMinutes).toBe(0);
    expect(StatsQuerySchema.parse({ tzOffsetMinutes: "99999" }).tzOffsetMinutes).toBe(0); // > UTC+14
    expect(StatsQuerySchema.parse({ tzOffsetMinutes: "-99999" }).tzOffsetMinutes).toBe(0); // < UTC-12
  });

  it("coerces a junk bucket to the day default", () => {
    expect(StatsQuerySchema.parse({ bucket: "nope" }).bucket).toBe("day");
  });
});
