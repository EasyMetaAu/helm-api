import { describe, expect, it } from "vitest";
import { createResponseWorkAdmission } from "./response-work-admission.js";

describe("response work admission", () => {
  it("shares one amplified byte budget and releases resized leases", () => {
    const admission = createResponseWorkAdmission({
      capacityBytes: 60,
      jsonAmplification: 2,
      minChargeBytes: 6,
    });

    const first = admission.acquire(5);
    const second = admission.acquire(10);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(admission.reservedBytes).toBe(30);
    expect(admission.acquire(16)).toMatchObject({ ok: false, reason: "busy" });

    if (!first.ok || !second.ok) throw new Error("expected response work leases");
    expect(first.lease.resize(20)).toEqual({ ok: true });
    expect(admission.reservedBytes).toBe(60);
    expect(second.lease.resize(11)).toMatchObject({ ok: false, reason: "busy" });
    first.lease.release();
    expect(second.lease.resize(11)).toEqual({ ok: true });
    second.lease.release();
    second.lease.release();
    expect(admission.reservedBytes).toBe(0);
  });
});
