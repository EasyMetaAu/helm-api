import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const view = readFileSync(
  new URL("./components/RequestDetailView.svelte", import.meta.url),
  "utf8",
);
const api = readFileSync(
  new URL("./api/request-trail.ts", import.meta.url),
  "utf8",
);
const admin = readFileSync(
  new URL(
    "../../../admin/src/routes/requests/[traceId]/+page.svelte",
    import.meta.url,
  ),
  "utf8",
);
describe("Portal full request-detail parity", () => {
  it("retains the admin detail sections and uses a Portal replay confirmation", () => {
    const ids = [...admin.matchAll(/data-testid="([^"]+)"/g)].map(
      (match) => match[1],
    );
    for (const id of ids.filter((id) => id !== "retry-request"))
      expect(view).toContain(`data-testid="${id}"`);
    expect(view).not.toContain("RetryDialog");
    expect(view).not.toContain('data-testid="retry-request"');
    expect(view).toContain('data-testid="replay-request"');
    expect(view).toContain("<ReplayDialog");
  });
  it("uses the same normalizer and lazy body/session recovery views", () => {
    expect(api).toContain("...body.decision");
    expect(api).toContain("return toDetail(");
    expect(view).toContain("DecisionChain");
    expect(view).toContain("RoutingSummary");
    expect(view).toContain("CostBreakdown");
    expect(view).toContain("rebuildSessionTranscript");
    expect(view).toContain("upstream_request");
    expect(api).toContain("apiFetch");
    expect(api).not.toContain("/admin/api");
    expect(api).not.toContain("rehydratePayloadBlobs");
  });
});
