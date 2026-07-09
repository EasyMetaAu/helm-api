import type { TelemetryStore } from "@helm/core";
import { describe, expect, it } from "vitest";
import { assertOwnsTrace } from "./ownership.js";

// getApiKeyId stub — the ONLY store method ownership consults (it must decide
// BEFORE any getByRequestId/getPayload read, spec §4.4 / R1).
function telemetry(owner: string | null): Pick<TelemetryStore, "getApiKeyId"> {
  return {
    async getApiKeyId() {
      return owner;
    },
  };
}

describe("assertOwnsTrace (spec §4.4 red lines)", () => {
  it("returns ok when the trace belongs to the caller's key", async () => {
    expect(await assertOwnsTrace(telemetry("k1"), "k1", "trace_1")).toBe("ok");
  });

  it("returns not_found — NOT forbidden — when the trace belongs to another key (R2: no enumeration)", async () => {
    // Someone else's request must be indistinguishable from a non-existent one,
    // else a key holder can probe which traceIds exist across the whole gateway.
    expect(await assertOwnsTrace(telemetry("k2"), "k1", "trace_1")).toBe("not_found");
  });

  it("returns not_found on an unknown / pruned trace (miss and not-yours share one branch)", async () => {
    expect(await assertOwnsTrace(telemetry(null), "k1", "trace_1")).toBe("not_found");
  });

  it("fails CLOSED (throws) when the caller keyId is missing — never a scopeless read (R5)", async () => {
    await expect(assertOwnsTrace(telemetry("k1"), "", "trace_1")).rejects.toThrow();
    // @ts-expect-error deliberately passing undefined to prove the runtime guard
    await expect(assertOwnsTrace(telemetry("k1"), undefined, "trace_1")).rejects.toThrow();
  });
});
