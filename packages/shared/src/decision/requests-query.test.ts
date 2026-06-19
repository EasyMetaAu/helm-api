import { describe, expect, it } from "vitest";
import {
  REQUESTS_PAGE_SIZE_DEFAULT,
  REQUESTS_PAGE_SIZE_MAX,
  RequestsQuerySchema,
} from "./requests-query.js";

// The schema parses an untrusted querystring (Hono's c.req.query() → all strings).
// It must be fail-open: defaults applied, pageSize clamped, junk swallowed.

describe("RequestsQuerySchema", () => {
  it("applies defaults on an empty query", () => {
    const q = RequestsQuerySchema.parse({});
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(REQUESTS_PAGE_SIZE_DEFAULT);
    expect(q.status).toBeUndefined();
    expect(q.decided_by).toBeUndefined();
    expect(q.lane).toBeUndefined();
    expect(q.model).toBeUndefined();
    expect(q.key_id).toBeUndefined();
    expect(q.start).toBeUndefined();
    expect(q.end).toBeUndefined();
  });

  it("coerces string scalars (querystring values are always strings)", () => {
    const q = RequestsQuerySchema.parse({ page: "3", pageSize: "25", start: "1000", end: "2000" });
    expect(q.page).toBe(3);
    expect(q.pageSize).toBe(25);
    expect(q.start).toBe(1000);
    expect(q.end).toBe(2000);
  });

  it("clamps pageSize to the max instead of allowing an unbounded scan", () => {
    expect(RequestsQuerySchema.parse({ pageSize: "100000" }).pageSize).toBe(REQUESTS_PAGE_SIZE_MAX);
  });

  it("fails open on junk page/pageSize → defaults (never throws)", () => {
    const q = RequestsQuerySchema.parse({ page: "abc", pageSize: "-5" });
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(REQUESTS_PAGE_SIZE_DEFAULT);
  });

  it("keeps valid enum filters and drops invalid ones", () => {
    expect(RequestsQuerySchema.parse({ status: "error" }).status).toBe("error");
    expect(RequestsQuerySchema.parse({ status: "nope" }).status).toBeUndefined();
    expect(RequestsQuerySchema.parse({ decided_by: "eval" }).decided_by).toBe("eval");
    expect(RequestsQuerySchema.parse({ decided_by: "nope" }).decided_by).toBeUndefined();
  });

  it("trims text filters and treats empty as unset", () => {
    expect(RequestsQuerySchema.parse({ lane: "  premium  " }).lane).toBe("premium");
    expect(RequestsQuerySchema.parse({ lane: "" }).lane).toBeUndefined();
    expect(RequestsQuerySchema.parse({ model: "gpt" }).model).toBe("gpt");
  });

  it("parses key_id (exact key scope) and treats empty as unset", () => {
    expect(RequestsQuerySchema.parse({ key_id: "  key_abc  " }).key_id).toBe("key_abc");
    expect(RequestsQuerySchema.parse({ key_id: "" }).key_id).toBeUndefined();
  });
});
