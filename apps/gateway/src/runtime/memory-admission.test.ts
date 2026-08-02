import { createResponseWorkAdmission, createRuntimeMemoryCoordinator } from "@helm/core";
import { describe, expect, it } from "vitest";
import { createBodyMemoryAdmission, readAdmittedRequestBody } from "./memory-admission.js";

describe("body memory admission (unlimited body size and aggregate capacity)", () => {
  it("shares one live capacity across HTTP, websocket ingress, and response work", () => {
    const coordinator = createRuntimeMemoryCoordinator({ capacityBytes: () => 100 });
    const http = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      jsonAmplification: 1,
      minRequestChargeBytes: 1,
      coordinator,
    });
    const websocket = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      jsonAmplification: 1,
      minRequestChargeBytes: 1,
      coordinator,
    });
    const response = createResponseWorkAdmission({
      capacityBytes: 100,
      jsonAmplification: 1,
      minChargeBytes: 1,
      coordinator,
    });

    const httpLease = http.acquire(60);
    const websocketLease = websocket.acquire(30);
    expect(httpLease.ok).toBe(true);
    expect(websocketLease.ok).toBe(true);
    expect(response.acquire(20)).toMatchObject({ ok: false, reason: "busy" });
    if (httpLease.ok) httpLease.lease.release();
    const responseLease = response.acquire(20);
    expect(responseLease.ok).toBe(true);
    if (responseLease.ok) responseLease.lease.release();
    if (websocketLease.ok) websocketLease.lease.release();
  });

  it("always permits a lease to shrink when live capacity falls", () => {
    let capacity = 100;
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      jsonAmplification: 2,
      minRequestChargeBytes: 1,
      capacityBytes: () => capacity,
    });
    const acquired = admission.acquire(40);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    capacity = 30;
    expect(acquired.lease.resize(20)).toEqual({ ok: true });
    expect(admission.reservedBytes).toBe(40);
    acquired.lease.release();
  });

  it("reports the amplified requested charge when a streamed resize is rejected", async () => {
    let capacityChecks = 0;
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      jsonAmplification: 2,
      minRequestChargeBytes: 1,
      capacityBytes: () => (++capacityChecks === 1 ? 100 : 5),
    });

    await expect(
      readAdmittedRequestBody(
        new Request("http://helm.test/v1/responses", { method: "POST", body: "abc" }),
        admission,
      ),
    ).rejects.toMatchObject({
      code: "server_overloaded",
      admission: { wireBytes: 3, requestedChargeBytes: 6 },
    });
    expect(admission.reservedBytes).toBe(0);
    expect(admission.pendingBytes).toBe(0);
  });

  it("shrinks and recovers admission from live safe capacity without a fixed wire limit", () => {
    let capacity = 100;
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      jsonAmplification: 2,
      minRequestChargeBytes: 10,
      capacityBytes: () => capacity,
    } as never);

    const first = admission.acquire(20);
    expect(first.ok).toBe(true);
    capacity = 30;
    expect(admission.acquire(1)).toMatchObject({ ok: false, cause: "capacity" });
    if (first.ok) first.lease.release();
    capacity = 200;
    expect(admission.acquire(80).ok).toBe(true);
  });

  it("never rejects for active capacity, even when charge exceeds the historical pool", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
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

  it("blocks new acquires while paused so waitForIdle can drain active leases", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    const active = admission.acquire(5);
    expect(active.ok).toBe(true);
    admission.pause();
    expect(admission.acquire(1)).toMatchObject({
      ok: false,
      reason: "busy",
      cause: "paused",
    });
    let idle = false;
    const waiting = admission.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    if (active.ok) {
      // In-flight lease may still resize while paused.
      expect(active.lease.resize(8).ok).toBe(true);
      active.lease.release();
    }
    await waiting;
    expect(idle).toBe(true);
    admission.resume();
    expect(admission.acquire(1).ok).toBe(true);
  });

  it("tracks charge for bookkeeping but never returns capacity-busy", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    const first = admission.acquire(6);
    expect(first.ok).toBe(true);
    expect(admission.reservedBytes).toBe(36);
    const second = admission.acquire(5);
    expect(second.ok).toBe(true);
    if (first.ok) first.lease.release();
    if (second.ok) second.lease.release();
    expect(admission.reservedBytes).toBe(0);
  });

  it("stops counting pending after materialize and still allows more acquires", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      jsonAmplification: 2,
      minRequestChargeBytes: 10,
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

  it("admits a body larger than the former hard wire limit", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 120,
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

  it("admits Content-Length beyond the former hard wire limit", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    const request = new Request("http://helm.test/v1/responses", {
      method: "POST",
      headers: { "content-length": "11" },
      body: "x".repeat(11),
    });

    const admitted = await readAdmittedRequestBody(request, admission);
    expect(admitted.text).toBe("x".repeat(11));
    admitted.release();
    expect(admission.reservedBytes).toBe(0);
  });

  it("rejects readAdmittedRequestBody while paused for maintenance", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      jsonAmplification: 6,
    });
    admission.pause();
    await expect(
      readAdmittedRequestBody(
        new Request("http://helm.test/v1/responses", { method: "POST", body: "{}" }),
        admission,
      ),
    ).rejects.toMatchObject({ status: 503, code: "database_maintenance" });
    expect(admission.reservedBytes).toBe(0);
  });

  it("does not enforce the legacy configured hard wire limit", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 1,
      jsonAmplification: 1,
    });
    const acquired = admission.acquire(2);
    expect(acquired.ok).toBe(true);
    if (acquired.ok) acquired.lease.release();
  });
});
