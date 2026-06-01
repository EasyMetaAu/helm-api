import type { ErrorClass } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { makeGeminiError, transformErrorOut } from "./error.js";

// Gemini error envelope (docs/05 §errors are translated into the client protocol's
// shape, docs/07). The native Gemini error wire form is
//   { "error": { "code": <http_status>, "message": <text>, "status": <ENUM> } }
// `code` is the HTTP status integer and `status` is Google's canonical-error enum
// string. We map all 8 Helm ErrorClass values to the correct (code, status) pair.

// Expected (error_class -> [http code, google status]) per docs/07 + Google's
// canonical error codes (https://cloud.google.com/apis/design/errors).
const EXPECTED: ReadonlyArray<readonly [ErrorClass, number, string]> = [
  ["auth_error", 401, "UNAUTHENTICATED"],
  ["invalid_request", 400, "INVALID_ARGUMENT"],
  ["lane_unavailable", 503, "UNAVAILABLE"],
  ["all_providers_failed", 502, "UNAVAILABLE"],
  ["capability_unsatisfiable", 422, "INVALID_ARGUMENT"],
  ["upstream_error", 502, "UNAVAILABLE"],
  ["timeout", 504, "DEADLINE_EXCEEDED"],
  ["rate_limited", 429, "RESOURCE_EXHAUSTED"],
];

describe("makeGeminiError (ErrorClass -> Gemini envelope)", () => {
  it.each(EXPECTED)("maps %s -> code %i / status %s", (cls, code, status) => {
    const out = makeGeminiError({ error_class: cls, message: "boom", trace_id: "t1" });
    expect(out.status).toBe(code);
    expect(out.body.error.code).toBe(code);
    expect(out.body.error.status).toBe(status);
    expect(out.body.error.message).toBe("boom");
  });

  it("preserves the human-readable message verbatim", () => {
    const out = makeGeminiError({
      error_class: "invalid_request",
      message: "contents must be a non-empty array",
      trace_id: "t9",
    });
    expect(out.body.error.message).toBe("contents must be a non-empty array");
  });
});

describe("transformErrorOut (HelmError -> Gemini envelope)", () => {
  it("re-shapes a pre-built HelmError without changing the status", () => {
    const out = transformErrorOut({
      error_class: "rate_limited",
      http_status: 429,
      message: "slow down",
      trace_id: "t1",
      provider_raw: null,
    });
    expect(out.status).toBe(429);
    expect(out.body.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(out.body.error.code).toBe(429);
  });
});
