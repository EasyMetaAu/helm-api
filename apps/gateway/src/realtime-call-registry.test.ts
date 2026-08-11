import type { RealtimeSidebandTarget } from "@helm/core";
import { describe, expect, it } from "vitest";
import { createRealtimeCallRegistry } from "./realtime-call-registry.js";

const TARGET: RealtimeSidebandTarget = {
  url: "wss://upstream.test/v1/realtime?call_id=rtc_1",
  headers: async () => ({ Authorization: "Bearer upstream" }),
};

describe("createRealtimeCallRegistry", () => {
  it("binds a call to the Helm key that created it and consumes it once", () => {
    const registry = createRealtimeCallRegistry({ ttlMs: 1_000, now: () => 10 });
    registry.put("rtc_1", "key-a", TARGET);

    expect(registry.take("rtc_1", "key-b")).toEqual({ ok: false, reason: "not_found" });
    expect(registry.take("rtc_1", "key-a")).toEqual({ ok: true, target: TARGET });
    expect(registry.take("rtc_1", "key-a")).toEqual({ ok: false, reason: "not_found" });
  });

  it("expires abandoned calls lazily", () => {
    let now = 10;
    const registry = createRealtimeCallRegistry({ ttlMs: 5, now: () => now });
    registry.put("rtc_1", "key-a", TARGET);
    now = 16;

    expect(registry.take("rtc_1", "key-a")).toEqual({ ok: false, reason: "not_found" });
    expect(registry.size).toBe(0);
  });

  it("bounds abandoned sideband calls under a high-cardinality request flood", () => {
    const registry = createRealtimeCallRegistry({ maxEntries: 2, now: () => 10 });
    registry.put("rtc_1", "key-a", TARGET);
    registry.put("rtc_2", "key-a", TARGET);
    registry.put("rtc_3", "key-a", TARGET);

    expect(registry.size).toBe(2);
    expect(registry.take("rtc_1", "key-a")).toEqual({ ok: false, reason: "not_found" });
    expect(registry.take("rtc_2", "key-a")).toEqual({ ok: true, target: TARGET });
  });
});
