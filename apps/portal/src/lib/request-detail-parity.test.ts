import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../routes/requests/[traceId]/+page.svelte", import.meta.url),
  "utf8",
);
const api = readFileSync(new URL("./api/portal.ts", import.meta.url), "utf8");

describe("Portal request-detail parity", () => {
  it("loads payload metadata first and heavy bodies only on demand", () => {
    expect(api).toContain("getPayloadMeta");
    expect(api).toContain("part=meta");
    expect(page).toContain("getPayloadMeta");
    expect(page).toContain('data-testid="load-conversation"');
    expect(page).toContain('data-testid="load-request-body"');
    expect(page).toContain('data-testid="load-response-body"');
    expect(page.match(/if \(requestId !== id\) return/g)).toHaveLength(4);
  });

  it("uses the Admin-grade image gallery and stream-aware response viewer", () => {
    expect(page).toContain("buildMediaGroups");
    expect(page).toContain("ImagePreview");
    expect(page).toContain('data-testid="media-overview"');
    expect(page).toContain('data-testid="media-group"');
    expect(page).toContain('variant="thumb"');
    expect(page).toContain("isSseStream");
    expect(page).toContain("StreamViewer");
  });

  it("keeps provider-forwarded payloads outside the Portal boundary", () => {
    expect(page).not.toContain("upstream_request");
    expect(api).not.toContain('part: "upstream_request"');
  });

  it("uses request_id for lookup while retaining client trace correlation", () => {
    expect(api).toContain("trace_id: string");
    expect(page).toContain("detail.request_id");
    expect(page).toContain("detail.trace_id");
  });
});
