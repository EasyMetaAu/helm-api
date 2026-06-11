import { describe, expect, it } from "vitest";
import { buildEgressAgentOptions } from "./egress.js";

describe("buildEgressAgentOptions", () => {
  it("uses safe keep-alive defaults and leaves the pool size at undici's default", () => {
    const opts = buildEgressAgentOptions({});
    expect(opts.keepAliveTimeout).toBe(30_000);
    expect(opts.keepAliveMaxTimeout).toBe(60_000);
    // No explicit `connections` by default → undici keeps its own default (we only
    // tune keep-alive, never shrink the pool unless an operator opts in).
    expect(opts.connections).toBeUndefined();
  });

  it("parses HELM_UNDICI_* overrides", () => {
    const opts = buildEgressAgentOptions({
      HELM_UNDICI_KEEPALIVE_MS: "10000",
      HELM_UNDICI_KEEPALIVE_MAX_MS: "120000",
      HELM_UNDICI_CONNECTIONS: "256",
    });
    expect(opts.keepAliveTimeout).toBe(10_000);
    expect(opts.keepAliveMaxTimeout).toBe(120_000);
    expect(opts.connections).toBe(256);
  });

  it("falls back to defaults on non-numeric / non-positive env", () => {
    const opts = buildEgressAgentOptions({
      HELM_UNDICI_KEEPALIVE_MS: "abc",
      HELM_UNDICI_KEEPALIVE_MAX_MS: "-5",
      HELM_UNDICI_CONNECTIONS: "0",
    });
    expect(opts.keepAliveTimeout).toBe(30_000);
    expect(opts.keepAliveMaxTimeout).toBe(60_000);
    expect(opts.connections).toBeUndefined(); // invalid pool size → omit, don't cap
  });
});
