import { UpstreamError } from "@helm/core";
import { describe, expect, it } from "vitest";
import { clientErrorMessage } from "./client-error.js";
import { errorDetailOf } from "./execute.js";

describe("client upstream error details", () => {
  it("projects the actual reason, status, code and request ID without diagnostic internals", () => {
    const detail = errorDetailOf(
      new UpstreamError(
        "upstream_error",
        "upstream returned 400",
        {
          error: {
            message: "Unknown parameter: thinking",
            code: "unknown_parameter",
            param: "thinking",
          },
          request_id: "req-123",
          prompt: "private payload",
          authorization: "Bearer private-key",
        },
        400,
        { "x-request-id": "req-header", "set-cookie": "private-cookie" },
      ),
    );
    const message = clientErrorMessage(detail, "request rejected");
    for (const value of [
      "Unknown parameter: thinking",
      "400",
      "unknown_parameter",
      "thinking",
      "req-header",
    ])
      expect(message).toContain(value);
    for (const value of [
      "private payload",
      "private-key",
      "private-cookie",
      "UpstreamError",
      "file://",
    ])
      expect(message).not.toContain(value);
  });
  it.each([
    [
      { base_resp: { status_code: 1008, status_msg: "insufficient balance" } },
      "insufficient balance",
      "1008",
    ],
    [
      { code: "ModelNotOpen", message: "Model is not enabled" },
      "Model is not enabled",
      "ModelNotOpen",
    ],
    [
      { response: { error: { message: "session expired", code: "expired" } } },
      "session expired",
      "expired",
    ],
  ])("recognizes upstream envelopes without copying the body", (raw, reason, code) => {
    const message = clientErrorMessage(
      errorDetailOf(new UpstreamError("upstream_error", "failed", raw, 400)),
      "request failed",
    );
    expect(message).toContain(reason);
    expect(message).toContain(code);
  });
  it("keeps an ambiguous paid outcome and removes URL credentials and signed query", () => {
    const detail = errorDetailOf(
      new UpstreamError(
        "upstream_error",
        "failed",
        {
          error: {
            message:
              "download failed https://user:pass@assets.test/x?signature=private#secret; api_key=private",
          },
        },
        503,
      ),
    );
    const message = clientErrorMessage(detail, "video create outcome is unknown");
    expect(message).toContain("outcome is unknown");
    expect(message).toContain("download failed");
    for (const secret of ["user:pass", "signature", "private", "#secret"])
      expect(message).not.toContain(secret);
  });
  it("does not turn HTML errors or a missing upstream reply into raw output", () => {
    expect(clientErrorMessage(null, "upstream error")).toBe("upstream error");
    expect(
      clientErrorMessage(
        errorDetailOf(
          new UpstreamError(
            "timeout",
            "upstream timed out",
            "<html>internal gateway config</html>",
            504,
          ),
        ),
        "upstream timed out",
      ),
    ).not.toContain("internal gateway config");
  });
});

it("explains unavailable accounts and timeouts even without an HTTP response", () => {
  const error = new UpstreamError("upstream_error", "oauth pool has no schedulable account", null);
  expect(clientErrorMessage(errorDetailOf(error), "all providers failed")).toContain(
    "No provider account is currently available",
  );
});

it("does not expose invalid-response bodies or upstream stack frames", () => {
  const broken = errorDetailOf(
    new UpstreamError(
      "upstream_error",
      "invalid response",
      { error: { code: "invalid_response" }, raw: '{"private":"truncated business response' },
      200,
    ),
  );
  expect(clientErrorMessage(broken, "request failed")).not.toContain("private");
  const stack = errorDetailOf(
    new UpstreamError(
      "upstream_error",
      "failed",
      { error: { message: "quota exhausted\n    at internal (/private/server.js:1:1)" } },
      500,
    ),
  );
  const message = clientErrorMessage(stack, "request failed");
  expect(message).toContain("quota exhausted");
  expect(message).not.toContain("/private/");
});
