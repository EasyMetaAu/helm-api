import { type ErrorClass, makeHelmError } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { makeOpenAIError, transformErrorOut } from "./openai-error.js";

describe("openai transformErrorOut", () => {
  it("wraps a HelmError in the native OpenAI error envelope with its mapped status", () => {
    const helm = makeHelmError({
      error_class: "auth_error",
      message: "missing or invalid API key",
      trace_id: "t1",
    });
    const out = transformErrorOut(helm);
    expect(out.status).toBe(401);
    expect(out.body).toEqual({
      error: {
        message: "missing or invalid API key",
        type: "authentication_error",
        code: null,
        param: null,
      },
    });
  });

  it("maps each error_class onto a legal OpenAI error.type + status", () => {
    const cases: Array<[ErrorClass, string, number]> = [
      ["auth_error", "authentication_error", 401],
      ["invalid_request", "invalid_request_error", 400],
      ["lane_unavailable", "server_error", 503],
      ["all_providers_failed", "server_error", 502],
      ["capability_unsatisfiable", "invalid_request_error", 422],
      ["upstream_error", "server_error", 502],
      ["timeout", "server_error", 504],
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

  it("passes the (already-redacted) message through verbatim", () => {
    const out = transformErrorOut(
      makeHelmError({ error_class: "upstream_error", message: "exact text 123", trace_id: "t" }),
    );
    expect(out.body.error.message).toBe("exact text 123");
  });

  it("makeOpenAIError builds + translates in one step", () => {
    const out = makeOpenAIError({
      error_class: "rate_limited",
      message: "slow down",
      trace_id: "t2",
    });
    expect(out.status).toBe(429);
    expect(out.body.error.type).toBe("rate_limit_error");
  });

  it("never leaks anything beyond {message,type,code,param} in the envelope", () => {
    const out = makeOpenAIError({ error_class: "auth_error", message: "m", trace_id: "secret-t" });
    expect(Object.keys(out.body)).toEqual(["error"]);
    expect(Object.keys(out.body.error)).toEqual(["message", "type", "code", "param"]);
    // No trace_id / provider_raw / http_status leakage into the wire envelope.
    expect(JSON.stringify(out.body)).not.toContain("secret-t");
  });
});
