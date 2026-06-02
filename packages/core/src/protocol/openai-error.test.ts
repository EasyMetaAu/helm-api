import { type ErrorClass, makeHelmError } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { makeOpenAIError, transformErrorOut } from "./openai-error.js";

describe("openai transformErrorOut", () => {
  it("wraps a HelmError in the canonical OpenAI error envelope with its mapped status", () => {
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
        type: "invalid_request_error",
        code: "invalid_api_key",
        trace_id: "t1",
      },
    });
  });

  it("maps each error_class onto the canonical OpenAI type + code + status (matches the gateway contract)", () => {
    const cases: Array<[ErrorClass, string, string, number]> = [
      ["auth_error", "invalid_request_error", "invalid_api_key", 401],
      ["invalid_request", "invalid_request_error", "invalid_request", 400],
      ["lane_unavailable", "api_error", "lane_unavailable", 503],
      ["all_providers_failed", "api_error", "all_providers_failed", 502],
      ["capability_unsatisfiable", "invalid_request_error", "capability_unsatisfiable", 422],
      ["upstream_error", "api_error", "upstream_error", 502],
      ["timeout", "api_error", "timeout", 504],
      ["rate_limited", "rate_limit_error", "rate_limited", 429],
    ];
    for (const [cls, type, code, status] of cases) {
      const out = transformErrorOut(
        makeHelmError({ error_class: cls, message: "x", trace_id: "t" }),
      );
      expect(out.body.error.type).toBe(type);
      expect(out.body.error.code).toBe(code);
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
    expect(out.body.error.code).toBe("rate_limited");
  });

  it("carries trace_id on the wire (docs/07 Debug UI) and emits exactly {message,type,code,trace_id}", () => {
    const out = makeOpenAIError({ error_class: "auth_error", message: "m", trace_id: "trace-7" });
    expect(Object.keys(out.body)).toEqual(["error"]);
    expect(Object.keys(out.body.error)).toEqual(["message", "type", "code", "trace_id"]);
    // trace_id is intentionally present (it is not a secret); nothing else leaks
    // (no provider_raw / http_status / message duplication beyond the envelope).
    expect(out.body.error.trace_id).toBe("trace-7");
  });
});
