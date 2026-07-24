import { describe, expect, it } from "vitest";
import { createBodyMemoryAdmission, readAdmittedRequestBody } from "./memory-admission.js";

describe("body memory admission", () => {
  it("charges a capacity-derived floor for tiny requests", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 100,
      maxWireBytes: 100,
      jsonAmplification: 2,
      minRequestChargeBytes: 40,
    });

    const first = admission.acquire(1);
    const second = admission.acquire(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(admission.reservedBytes).toBe(80);
    expect(admission.acquire(1)).toMatchObject({ ok: false, reason: "busy" });
    if (first.ok) first.lease.release();
    if (second.ok) second.lease.release();
    expect(admission.reservedBytes).toBe(0);
  });

  it("pauses new requests and waits for active leases before maintenance", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      maxWireBytes: 10,
      jsonAmplification: 6,
    });
    const active = admission.acquire(5);
    expect(active.ok).toBe(true);
    admission.pause();
    expect(admission.acquire(1)).toMatchObject({ ok: false, reason: "busy" });
    let idle = false;
    const waiting = admission.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    if (active.ok) active.lease.release();
    await waiting;
    admission.resume();
    expect(admission.acquire(1).ok).toBe(true);
  });

  it("charges parsed JSON amplification and releases the shared budget", () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      maxWireBytes: 10,
      jsonAmplification: 6,
    });
    const first = admission.acquire(6);
    expect(first.ok).toBe(true);
    expect(admission.reservedBytes).toBe(36);
    expect(admission.acquire(5)).toMatchObject({ ok: false, reason: "busy" });
    if (first.ok) first.lease.release();
    expect(admission.reservedBytes).toBe(0);
  });

  it("rejects new bodies when live heap pressure has consumed protected headroom", () => {
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

    expect(admission.acquire(1)).toMatchObject({ ok: false, reason: "busy" });
    heapUsedBytes = 60;
    const admitted = admission.acquire(1);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      heapUsedBytes = 71;
      expect(admitted.lease.resize(1)).toMatchObject({ ok: false, reason: "busy" });
      admitted.lease.release();
    }
  });

  it("bounds a streaming body before JSON parsing and returns its lease", async () => {
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
    expect(admission.reservedBytes).toBeGreaterThan(0);
    admitted.release();
    expect(admission.reservedBytes).toBe(0);

    await expect(
      readAdmittedRequestBody(
        new Request("http://helm.test/v1/responses", { method: "POST", body: "x".repeat(21) }),
        admission,
      ),
    ).rejects.toMatchObject({ status: 413, code: "request_too_large" });
  });

  it("best-effort cancels the body when Content-Length is rejected before reading", async () => {
    const admission = createBodyMemoryAdmission({
      activeRequestBytes: 60,
      maxWireBytes: 10,
      jsonAmplification: 6,
    });
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const request = new Request("http://helm.test/v1/responses", {
      method: "POST",
      headers: { "content-length": "11" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readAdmittedRequestBody(request, admission)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
    expect(canceled).toBe(true);
    expect(admission.reservedBytes).toBe(0);
  });
});
