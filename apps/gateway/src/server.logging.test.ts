import { describe, expect, it } from "vitest";
import { routeDecisionLogFields } from "./server.js";

describe("routeDecisionLogFields", () => {
  it("preserves the server request id and independent client correlation id", () => {
    expect(
      routeDecisionLogFields({
        request_id: "server-request-1",
        trace_id: "client-correlation-1",
      }),
    ).toEqual({
      request_id: "server-request-1",
      trace_id: "client-correlation-1",
    });
  });
});
