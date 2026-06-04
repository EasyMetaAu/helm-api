import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

describe("GET / (landing page)", () => {
  it("returns 200 HTML with the product name and links to the public surface", async () => {
    const app = createApp({ logger: { log: () => {} } });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Helm API");
    // Links to the documented public + admin surface.
    for (const path of ["/docs", "/v1/models", "/healthz", "/admin"]) {
      expect(html).toContain(`href="${path}"`);
    }
    // /version is surfaced (referenced in the dashboard copy + fetched live).
    expect(html).toContain("/version");
  });

  it("is unauthenticated (no key required)", async () => {
    const app = createApp({ logger: { log: () => {} } });
    const res = await app.request("/"); // no Authorization header
    expect(res.status).toBe(200);
  });
});
