import { describe, expect, it } from "vitest";
import { createSpeedHistory } from "./speed.js";

describe("bounded recent account speed", () => {
  it("combines TTFT and throughput, expires observations, and isolates models", () => {
    const speed = createSpeedHistory();
    speed.record("a", "m", 100, 100, 1000, 1000);
    expect(speed.read("a", "m", 1001)).toMatchObject({
      ttftMs: 100,
      tokensPerSecond: 100,
      estimateMs: 2100,
    });
    expect(speed.read("a", "other", 1001)).toBeNull();
    expect(speed.read("a", "m", 3_601_001)).toBeNull();
  });
  it("does not invent tokens per second when usage is absent", () => {
    const speed = createSpeedHistory();
    speed.record("a", "m", 20, null, 50, 1);
    expect(speed.read("a", "m", 2)).toMatchObject({
      ttftMs: 20,
      tokensPerSecond: null,
      estimateMs: 20,
    });
  });
  it("bounds retained account/model records", () => {
    const speed = createSpeedHistory(2);
    for (const account of ["a", "b", "c"]) speed.record(account, "m", 20, null, 50, 1);
    expect(speed.read("a", "m", 2)).toBeNull();
    expect(speed.read("c", "m", 2)).not.toBeNull();
  });
});
