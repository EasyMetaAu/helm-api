import { type ErrorClass, makeHelmError } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { makeGeminiError, transformErrorOut } from "./error.js";

describe("gemini transformErrorOut", () => {
  it("wraps a HelmError in the native Google error envelope with its mapped code", () => {
    const helm = makeHelmError({
      error_class: "auth_error",
      message: "missing or invalid API key",
      trace_id: "t1",
    });
    const out = transformErrorOut(helm);
    expect(out.status).toBe(401);
    expect(out.body).toEqual({
      error: {
        code: 401,
        message: "missing or invalid API key",
        status: "UNAUTHENTICATED",
      },
    });
  });

  it("maps each error_class onto a canonical Google status + numeric code", () => {
    const cases: Array<[ErrorClass, string, number]> = [
      ["auth_error", "UNAUTHENTICATED", 401],
      ["invalid_request", "INVALID_ARGUMENT", 400],
      ["lane_unavailable", "UNAVAILABLE", 503],
      ["all_providers_failed", "INTERNAL", 502],
      ["capability_unsatisfiable", "FAILED_PRECONDITION", 422],
      ["upstream_error", "INTERNAL", 502],
      ["timeout", "DEADLINE_EXCEEDED", 504],
      ["rate_limited", "RESOURCE_EXHAUSTED", 429],
    ];
    for (const [cls, status, code] of cases) {
      const out = transformErrorOut(
        makeHelmError({ error_class: cls, message: "x", trace_id: "t" }),
      );
      expect(out.body.error.status).toBe(status);
      expect(out.body.error.code).toBe(code);
      expect(out.status).toBe(code);
    }
  });

  it("passes the (already-redacted) message through verbatim", () => {
    const out = transformErrorOut(
      makeHelmError({ error_class: "timeout", message: "exact text 123", trace_id: "t" }),
    );
    expect(out.body.error.message).toBe("exact text 123");
  });

  it("makeGeminiError builds + translates in one step", () => {
    const out = makeGeminiError({
      error_class: "rate_limited",
      message: "slow down",
      trace_id: "t2",
    });
    expect(out.status).toBe(429);
    expect(out.body.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(out.body.error.code).toBe(429);
  });

  it("never leaks anything beyond {code,message,status} in the envelope", () => {
    const out = makeGeminiError({ error_class: "auth_error", message: "m", trace_id: "secret-t" });
    expect(Object.keys(out.body)).toEqual(["error"]);
    expect(Object.keys(out.body.error)).toEqual(["code", "message", "status"]);
    expect(JSON.stringify(out.body)).not.toContain("secret-t");
  });
});
