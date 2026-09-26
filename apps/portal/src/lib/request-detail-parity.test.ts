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

  it("shows throughput, fallback attempts, and a real cost total instead of the admin cost-breakdown component", () => {
    // The admin CostBreakdown component reads routing_usd/eval_usd, which the
    // portal never populates (§4.3) — showing it renders two permanently-empty
    // rows next to a meaningless "Routing — / Eval —". Portal renders a plain
    // total instead of importing that component.
    expect(page).not.toContain("CostBreakdown");
    expect(page).toContain('data-testid="cost-total"');
    // Throughput (TPS / time-to-first-token / generation time) mirrors admin's
    // detail page fields, now exposed by toPortalDecisionView.
    expect(page).toContain('data-testid="throughput"');
    expect(page).toContain('data-testid="tps"');
    expect(page).toContain('data-testid="ttfb"');
    expect(page).toContain('data-testid="generation-ms"');
    // Fallback attempts: outcome + latency only (never provider/alias/model —
    // R7, docs/12 §8).
    expect(page).toContain('data-testid="attempt-row"');
    expect(page).toContain("detail.attempts");
    expect(page).not.toContain("attempt.provider");
    expect(page).not.toContain("attempt.alias");
    // Requested vs. effective reasoning effort.
    expect(page).toContain("detail.requested_reasoning_effort");
    expect(page).toContain("detail.reasoning_effort");
  });

  it("normalizes attempts/tps/ttfb_ms/generation_ms so an older gateway that omits them can't crash the page", () => {
    // These fields are new (this change); a not-yet-upgraded gateway simply
    // omits the keys, which JSON.parse turns into `undefined` — the template's
    // `!== null` checks and `.length` access don't tolerate that. Guard once
    // at the load site instead of scattering `?? []` through the template.
    expect(page).toContain("normalizePortalDetail");
    expect(page).toContain("detail = normalizePortalDetail(nextDetail)");
  });
});
