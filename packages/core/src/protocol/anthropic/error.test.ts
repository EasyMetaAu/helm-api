import { makeHelmError } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { makeAnthropicError, transformErrorOut } from "./error.js";

describe("anthropic transformErrorOut", () => {
  it("wraps a HelmError in the native Anthropic error envelope with its mapped status", () => {
    const helm = makeHelmError({
      error_class: "auth_error",
      message: "missing or invalid API key",
      trace_id: "t1",
    });
    const out = transformErrorOut(helm);
    expect(out.status).toBe(401);
    expect(out.body).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "missing or invalid API key" },
    });
  });

  it("maps each error_class onto a legal Anthropic error.type", () => {
    const cases: Array<[Parameters<typeof makeHelmError>[0]["error_class"], string, number]> = [
      ["auth_error", "authentication_error", 401],
      ["invalid_request", "invalid_request_error", 400],
      ["lane_unavailable", "overloaded_error", 503],
      ["all_providers_failed", "api_error", 502],
      ["capability_unsatisfiable", "invalid_request_error", 422],
      ["upstream_error", "api_error", 502],
      ["timeout", "api_error", 504],
      ["rate_limited", "rate_limit_error", 429],
    ];
    for (const [cls, type, status] of cases) {
      const out = transformErrorOut(
        makeHelmError({ error_class: cls, message: "x", trace_id: "t" }),
      );
      expect(out.body.error.type).toBe(type);
      expect(out.status).toBe(status);
    }
  });

  it("makeAnthropicError builds + translates in one step", () => {
    const out = makeAnthropicError({
      error_class: "rate_limited",
      message: "slow down",
      trace_id: "t2",
    });
    expect(out.status).toBe(429);
    expect(out.body.error.type).toBe("rate_limit_error");
  });

  it("never leaks anything beyond type + message in the envelope", () => {
    const out = makeAnthropicError({ error_class: "upstream_error", message: "m", trace_id: "t" });
    expect(Object.keys(out.body)).toEqual(["type", "error"]);
    expect(Object.keys(out.body.error)).toEqual(["type", "message"]);
  });
});
