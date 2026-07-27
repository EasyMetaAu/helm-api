import { describe, expect, it } from "vitest";
import { createBodyMemoryAdmission, readAdmittedRequestBody } from "./memory-admission.js";

describe("body memory admission (unlimited)", () => {
  it("never rejects for active capacity, even when charge exceeds the historical pool", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      maxWireBytes: 100,
      jsonAmplification: 2,
      minRequestChargeBytes: 40,
    });

    const first = admission.acquire(1);
    const second = admission.acquire(1);
    const third = admission.acquire(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect(admission.reservedBytes).toBe(120);
    if (first.ok) first.lease.release();
    if (second.ok) second.lease.release();
    if (third.ok) third.lease.release();
    expect(admission.reservedBytes).toBe(0);
  });

  it("ignores pause for new acquires and still waits for active leases", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      maxWireBytes: 10,
      jsonAmplification: 6,
    });
    const active = admission.acquire(5);
    expect(active.ok).toBe(true);
    admission.pause();
    const second = admission.acquire(1);
    expect(second.ok).toBe(true);
    let idle = false;
    const waiting = admission.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    if (active.ok) active.lease.release();
    await Promise.resolve();
    expect(idle).toBe(false);
    if (second.ok) second.lease.release();
    await waiting;
    expect(idle).toBe(true);
    admission.resume();
  });

  it("tracks charge for bookkeeping but never returns busy", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      maxWireBytes: 10,
      jsonAmplification: 6,
    });
    const first = admission.acquire(6);
    expect(first.ok).toBe(true);
    expect(admission.reservedBytes).toBe(36);
    expect(admission.acquire(5).ok).toBe(true);
    if (first.ok) first.lease.release();
  });

  it("never rejects for live heap pressure", () => {
    let heapUsedBytes = 71;
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      maxWireBytes: 100,
      jsonAmplification: 2,
      minRequestChargeBytes: 10,
      heapLimitBytes: 100,
      protectedHeapBytes: 20,
      heapUsedBytes: () => heapUsedBytes,
    });

    const admitted = admission.acquire(1);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      heapUsedBytes = 99;
      expect(admitted.lease.resize(50).ok).toBe(true);
      admitted.lease.release();
    }
  });

  it("stops counting pending after materialize and still allows more acquires", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      maxWireBytes: 100,
      jsonAmplification: 2,
      minRequestChargeBytes: 10,
      heapLimitBytes: 100,
      protectedHeapBytes: 20,
      heapUsedBytes: () => 90,
    });

    const active = admission.acquire(1);
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    active.lease.materialized();
    active.lease.materialized();
    expect(admission.reservedBytes).toBe(10);
    expect(admission.pendingBytes).toBe(0);

    const next = admission.acquire(1);
    expect(next.ok).toBe(true);
    if (next.ok) next.lease.release();
    active.lease.release();
    active.lease.release();
    expect(admission.reservedBytes).toBe(0);
    expect(admission.pendingBytes).toBe(0);
  });

  it("reads any streaming body size without capacity rejection", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 120,
      maxWireBytes: 20,
      jsonAmplification: 6,
    });
    const admitted = await readAdmittedRequestBody(
      new Request("http://helm.test/v1/responses", { method: "POST", body: '{"ok":true}' }),
      admission,
    );
    expect(admitted.text).toBe('{"ok":true}');
    expect(Buffer.from(admitted.bytes).toString("utf8")).toBe('{"ok":true}');
    expect(admission.reservedBytes).toBeGreaterThan(0);
    expect(admission.pendingBytes).toBe(admission.reservedBytes);
    admitted.materialized();
    expect(admission.pendingBytes).toBe(0);
    admitted.release();
    expect(admission.reservedBytes).toBe(0);

    const large = await readAdmittedRequestBody(
      new Request("http://helm.test/v1/responses", { method: "POST", body: "x".repeat(21) }),
      admission,
    );
    expect(large.text).toBe("x".repeat(21));
    large.release();
    expect(admission.reservedBytes).toBe(0);
  });

  it("admits Content-Length beyond historical maxWireBytes and reads the body", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      maxWireBytes: 10,
      jsonAmplification: 6,
    });
    const payload = "x".repeat(11);
    const request = new Request("http://helm.test/v1/responses", {
      method: "POST",
      headers: { "content-length": String(payload.length) },
      body: payload,
    });

    const admitted = await readAdmittedRequestBody(request, admission);
    expect(admitted.text).toBe(payload);
    admitted.release();
    expect(admission.reservedBytes).toBe(0);
  });

  it("exposes unlimited maxWireBytes regardless of configured historical limits", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 1,
      maxWireBytes: 1,
      jsonAmplification: 1,
    });
    expect(admission.maxWireBytes).toBe(Number.MAX_SAFE_INTEGER);
  });
});
