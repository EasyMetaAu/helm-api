import { afterEach, describe, expect, it, vi } from "vitest";
import * as portal from "./portal";
import { ApiError } from "./client";

vi.mock("$app/paths", () => ({ base: "/portal" }));
vi.mock("$lib/auth", () => ({ getKey: () => "test-key", clearKey: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("Portal debug API", () => {
  it("opens an HTTP 200 decision-only detail using its recorded request ID", async () => {
    const decision = {
      request_id: "own-request",
      trace_id: "client-trace",
      final: { status: "ok", model_alias: "fixture-model" },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ decision }))
      .mockResolvedValueOnce(
        Response.json({ decision, request_id: "own-request", tps: 17 }),
      )
      .mockResolvedValueOnce(
        Response.json({ decision: { trace_id: "client-trace" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ decision, request_id: "different-request" }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(portal.getRequestDetail("own-request")).resolves.toEqual({
      status: 200,
      data: { decision, request_id: "own-request" },
    });
    await expect(
      portal.getRequestByTrace("client-trace"),
    ).resolves.toMatchObject({
      status: 200,
      data: { decision, request_id: "own-request", tps: 17 },
    });
    await expect(portal.getRequestDetail("own-request")).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(portal.getRequestDetail("own-request")).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("distinguishes pending telemetry, missing requests, and ambiguous traces", async () => {
    const pending = {
      status: "in_progress",
      request_id: "r1",
      phase: "telemetry_pending",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(pending, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ code: "request_not_found" }, { status: 404 }),
      )
      .mockResolvedValueOnce(
        Response.json({ code: "ambiguous_trace_id" }, { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(portal.getRequestDetail("r1")).resolves.toEqual({
      status: 202,
      data: pending,
    });
    await expect(portal.getRequestDetail("gone")).rejects.toMatchObject({
      status: 404,
      code: "request_not_found",
    });
    await expect(portal.getRequestByTrace("user/a?b")).rejects.toMatchObject({
      status: 409,
      code: "ambiguous_trace_id",
    });
    expect(fetch.mock.calls[2][0]).toBe(
      "/portal/api/requests/by-trace/user%2Fa%3Fb",
    );
  });

  it("keeps replay receipts distinct from pre-dispatch errors", async () => {
    const receipt = {
      status: "outcome_unknown",
      code: "replay_outcome_unknown",
      source_request_id: "r1",
      request_id: null,
      upstream_status: null,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(receipt, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json(
          { code: "replay_rate_limited" },
          { status: 429, headers: { "Retry-After": "10" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { code: "auth_error" } }, { status: 401 }),
      );
    vi.stubGlobal("fetch", fetch);
    const token = "71eb99fc-a50a-48c5-ab73-631f47012490";

    await expect(portal.replayRequest("r1", token)).resolves.toEqual({
      status: 503,
      data: receipt,
    });
    const request = fetch.mock.calls[0][1];
    expect(request.method).toBe("POST");
    expect(request.body).toBeUndefined();
    expect(new Headers(request.headers).get("Idempotency-Key")).toBe(token);
    expect(new Headers(request.headers).get("Authorization")).toBe(
      "Bearer test-key",
    );
    await expect(portal.replayRequest("r1", token)).rejects.toMatchObject({
      status: 429,
      code: "replay_rate_limited",
      retryAfter: "10",
    });
    await expect(portal.replayRequest("r1", token)).rejects.toMatchObject({
      status: 401,
      code: "auth_error",
    });
  });

  it("sends scoped list filters and reports unavailable memory with a code", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [] }))
      .mockResolvedValueOnce(
        Response.json({ code: "memory_unavailable" }, { status: 503 }),
      );
    vi.stubGlobal("fetch", fetch);
    await portal.getRequests({
      lane: "balanced",
      decided_by: "rules",
      session: "A / B",
    });
    expect(
      new URL(fetch.mock.calls[0][0], "https://example.test").searchParams,
    ).toEqual(
      new URLSearchParams({
        lane: "balanced",
        decided_by: "rules",
        session: "A / B",
      }),
    );
    const error = await portal
      .getMemoryStats()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: "memory_unavailable" });
  });

  it("builds an owned request-scoped URL for detached image bytes", () => {
    expect(portal.payloadBlobUrl("r/1", "a".repeat(64))).toBe(
      "/portal/api/requests/r%2F1/payload-blobs/" + "a".repeat(64),
    );
  });
});
