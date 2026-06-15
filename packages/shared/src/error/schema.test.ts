import { describe, expect, it } from "vitest";
import {
  ERROR_CLASS_HTTP_STATUS,
  ErrorClassSchema,
  HelmErrorSchema,
  makeHelmError,
} from "./schema.js";

const EXPECTED: ReadonlyArray<readonly [string, number]> = [
  ["auth_error", 401],
  ["invalid_request", 400],
  ["lane_unavailable", 503],
  ["all_providers_failed", 502],
  ["capability_unsatisfiable", 422],
  ["upstream_error", 502],
  ["timeout", 504],
  ["rate_limited", 429],
  ["client_abort", 499],
];

describe("error_class -> HTTP status map", () => {
  it("covers exactly the enum, no gaps or extras", () => {
    const enumValues = [...ErrorClassSchema.options].sort();
    const mapKeys = Object.keys(ERROR_CLASS_HTTP_STATUS).sort();
    expect(mapKeys).toEqual(enumValues);
  });

  it.each(EXPECTED)("maps %s -> %i per docs/07", (cls, status) => {
    expect(ERROR_CLASS_HTTP_STATUS[cls as keyof typeof ERROR_CLASS_HTTP_STATUS]).toBe(status);
  });
});

describe("HelmErrorSchema", () => {
  it("accepts a valid error with provider_raw object", () => {
    const ok = {
      error_class: "upstream_error",
      http_status: 502,
      message: "upstream failed",
      trace_id: "t1",
      provider_raw: { code: "x" },
    };
    expect(HelmErrorSchema.safeParse(ok).success).toBe(true);
  });

  it("accepts a valid error with null provider_raw", () => {
    const ok = {
      error_class: "timeout",
      http_status: 504,
      message: "timed out",
      trace_id: "t1",
      provider_raw: null,
    };
    expect(HelmErrorSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects an unknown error_class", () => {
    const bad = {
      error_class: "server_error",
      http_status: 500,
      message: "x",
      trace_id: "t1",
      provider_raw: null,
    };
    const res = HelmErrorSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["error_class"]);
    }
  });

  it.each([
    "trace_id",
    "message",
    "error_class",
    "http_status",
  ])("rejects when required field %s is missing", (field) => {
    const base: Record<string, unknown> = {
      error_class: "auth_error",
      http_status: 401,
      message: "x",
      trace_id: "t1",
      provider_raw: null,
    };
    delete base[field];
    const res = HelmErrorSchema.safeParse(base);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === field)).toBe(true);
    }
  });

  it("rejects an empty trace_id", () => {
    const bad = {
      error_class: "auth_error",
      http_status: 401,
      message: "x",
      trace_id: "",
      provider_raw: null,
    };
    expect(HelmErrorSchema.safeParse(bad).success).toBe(false);
  });
});

describe("makeHelmError factory", () => {
  it("derives http_status from the map (caller cannot override)", () => {
    const e = makeHelmError({
      error_class: "rate_limited",
      message: "slow down",
      trace_id: "t1",
    });
    expect(e.http_status).toBe(429);
    expect(e.provider_raw).toBeNull();
  });

  it("round-trips through the schema idempotently", () => {
    const e = makeHelmError({ error_class: "timeout", message: "x", trace_id: "t1" });
    expect(e.http_status).toBe(504);
    const reparsed = HelmErrorSchema.parse(e);
    expect(reparsed).toEqual(e);
  });
});
