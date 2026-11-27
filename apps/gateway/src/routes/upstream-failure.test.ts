import { UpstreamError } from "@helm/core";
import { expect, it, vi } from "vitest";
import type { RecordServedDeps } from "./payload-capture.js";
import { recordUpstreamFailure } from "./upstream-failure.js";

it("stores utility failure under its owning key with bounded, scrubbed upstream diagnostics", async () => {
  const enqueueTelemetry = vi.fn();
  const deps = {
    telemetry: { insert: vi.fn() },
    now: () => 1,
    redact: (value: unknown) => value,
    writes: { enqueueTelemetry },
    capturePayloads: () => true,
  } as unknown as RecordServedDeps;
  await recordUpstreamFailure(deps, {
    keyId: "owner",
    alias: "minimax/video",
    model: "MiniMax-H3",
    operation: "video_poll",
    requestId: "poll",
    error: new UpstreamError(
      "upstream_error",
      "poll failed",
      { base_resp: { status_code: 1004, status_msg: "invalid task" }, api_key: "private" },
      401,
    ),
  });
  expect(enqueueTelemetry).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKeyId: "owner",
      decision: expect.objectContaining({
        request_id: "poll",
        final: expect.objectContaining({
          error_detail: expect.objectContaining({
            upstream_status: 401,
            provider_raw: {
              base_resp: { status_code: 1004, status_msg: "invalid task" },
              api_key: "[redacted]",
            },
          }),
        }),
      }),
    }),
  );
});
