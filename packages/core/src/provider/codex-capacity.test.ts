import { describe, expect, it } from "vitest";
import { isCodexCapacityRejection } from "./codex-capacity.js";
import { UpstreamError } from "./openai.js";

const message = "Selected model is at capacity. Please try a different model.";
describe("Codex capacity rejection classification", () => {
  it.each([401, 403, 400, 500, 502])("does not retry a conflicting HTTP %i response", (status) => {
    expect(
      isCodexCapacityRejection(
        new UpstreamError(
          "upstream_error",
          message,
          {
            error: { message },
          },
          status,
        ),
      ),
    ).toBe(false);
  });
  it.each([
    "response_create_outcome_unknown",
    "insufficient_quota",
    "invalid_api_key",
    "invalid_request_error",
  ])("does not override structured %s with capacity prose", (code) => {
    expect(
      isCodexCapacityRejection(
        new UpstreamError("upstream_error", message, {
          type: "error",
          error: { code, message },
        }),
      ),
    ).toBe(false);
  });
  it("does not retry a transport exception or a success payload containing the text", () => {
    expect(isCodexCapacityRejection(new Error(message))).toBe(false);
    expect(isCodexCapacityRejection(new UpstreamError("upstream_error", message))).toBe(false);
    expect(
      isCodexCapacityRejection(
        new UpstreamError("upstream_error", message, {
          type: "response.output_text.delta",
          error: { message },
        }),
      ),
    ).toBe(false);
  });
  it("does not mistake a structurally invalid request for capacity", () => {
    expect(
      isCodexCapacityRejection(
        new UpstreamError("upstream_error", message, {
          type: "error",
          error: { type: "invalid_request_error", message },
        }),
      ),
    ).toBe(false);
  });
});
