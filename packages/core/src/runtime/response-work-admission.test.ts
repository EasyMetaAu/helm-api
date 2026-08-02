import { describe, expect, it } from "vitest";
import { createResponseWorkAdmission } from "./response-work-admission.js";

describe("response work admission", () => {
  it("uses the current safe capacity on every acquire", () => {
    let capacity = 60;
    const admission = createResponseWorkAdmission({
      capacityBytes: 60,
      dynamicCapacityBytes: () => capacity,
      jsonAmplification: 2,
      minChargeBytes: 6,
    } as never);

    const first = admission.acquire(10);
    expect(first.ok).toBe(true);
    capacity = 10;
    expect(admission.acquire(1)).toMatchObject({ ok: false, reason: "busy" });
    if (first.ok) first.lease.release();
    capacity = 100;
    expect(admission.acquire(30).ok).toBe(true);
  });

  it("always permits a lease to shrink when live capacity falls", () => {
    let capacity = 100;
    const admission = createResponseWorkAdmission({
      capacityBytes: 100,
      dynamicCapacityBytes: () => capacity,
      jsonAmplification: 2,
      minChargeBytes: 1,
    });
    const acquired = admission.acquire(40);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    capacity = 30;
    expect(acquired.lease.resize(20)).toEqual({ ok: true });
    expect(admission.reservedBytes).toBe(40);
    acquired.lease.release();
  });

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
