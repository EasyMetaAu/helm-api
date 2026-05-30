import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lane } from "./lanes.js";
import { listLanes, saveLane } from "./lanes.js";

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (DoD: no core
// import). These tests pin the client contract against a mocked fetch.

function laneRow(name: string, overrides: Partial<Lane> = {}): Record<string, unknown> {
  return {
    name,
    purpose: `${name} purpose`,
    primary: `${name}_primary`,
    fallback: [],
    constraints: { require_tools: false, require_json: false },
    ...overrides,
  };
}

describe("lanes api client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listLanes GETs /admin/api/lanes and returns the lane array", async () => {
    const rows = [laneRow("economy"), laneRow("balanced"), laneRow("premium")];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );

    const lanes = await listLanes();

    expect(fetch).toHaveBeenCalledWith("/admin/api/lanes", expect.objectContaining({}));
    expect(lanes.map((l) => l.name)).toEqual(["economy", "balanced", "premium"]);
    expect(lanes[0].constraints.require_tools).toBe(false);
  });

  it("saveLane PUTs /admin/api/lanes/:name with the lane body (no name field)", async () => {
    const lane: Lane = {
      name: "coding",
      purpose: "coding",
      primary: "best_code_model",
      fallback: ["premium"],
      constraints: { require_tools: true, require_json: false, max_latency_ms: null },
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ primary: "best_code_model" }), { status: 200 }),
    );

    await saveLane("coding", lane);

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/admin/api/lanes/coding");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body.primary).toBe("best_code_model");
    expect(body.name).toBeUndefined(); // strictObject on the server: name must NOT be sent
    expect(body.fallback).toEqual(["premium"]);
  });

  it("saveLane rejects when the server returns a non-2xx (fail-closed)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid lane" }), { status: 400 }),
    );
    const lane: Lane = {
      name: "balanced",
      primary: "x",
      fallback: [],
      constraints: { require_tools: false, require_json: false, max_latency_ms: null },
    };

    await expect(saveLane("balanced", lane)).rejects.toThrow();
  });
});
