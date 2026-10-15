import { createSqliteDb, SqliteConfigStore } from "@helm/core";
import { IanaTimezoneSchema } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { setAccountSettings } from "./account-settings.js";
import { createEgressTimezoneResolver, getAccountTimezone } from "./account-timezone.js";

const key = Buffer.alloc(32, 7);
const proxy = { type: "http" as const, host: "proxy.test", port: 8080, password: "private" };
describe("account timezone", () => {
  it("validates IANA zones, not country names, abbreviations, or offsets", () => {
    for (const zone of ["US", "PST", "+08:00", "Mars/Olympus", ""])
      expect(IanaTimezoneSchema.safeParse(zone).success).toBe(false);
    for (const zone of ["UTC", "Etc/UTC", "America/New_York", "Asia/Kolkata"])
      expect(IanaTimezoneSchema.safeParse(zone).success).toBe(true);
  });
  it("uses the pinned proxy, fails over, sends no credentials, and caches only validated timezone", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ location: { timezone: "America/New_York" } }));
    const makeFetch = vi.fn(() => fetch);
    const resolver = createEgressTimezoneResolver({ makeFetch });
    expect(await resolver(proxy)).toMatchObject({
      effective: "America/New_York",
      source: "ipapi.is",
    });
    expect(makeFetch).toHaveBeenCalledWith(proxy);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://ipwho.is/",
      "https://api.ipapi.is/",
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("private");
    await resolver(proxy);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not reuse cache for a different egress and coalesces concurrent requests", async () => {
    let time = 1;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json({ success: true, timezone: { id: "America/Los_Angeles" } }),
      );
    const resolver = createEgressTimezoneResolver({ makeFetch: () => fetch, now: () => time });
    await Promise.all([resolver(proxy), resolver(proxy)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await resolver({ ...proxy, host: "other.test" });
    expect(fetch).toHaveBeenCalledTimes(2);
    time += 16 * 60_000;
    await resolver(proxy);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("invalid or failed results yield unknown, without stale or server-timezone fallback", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json({ success: false, timezone: { id: "US" } }));
    const resolver = createEgressTimezoneResolver({ makeFetch: () => fetch });
    expect(await resolver()).toMatchObject({ effective: null, source: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(2);
    await resolver();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("manual override is live, isolated, encrypted, clearable, and never triggers IP lookup", async () => {
    const config = new SqliteConfigStore(createSqliteDb(":memory:"));
    const detect = vi.fn(async () => ({
      effective: "America/New_York",
      source: "ipapi.is" as const,
      checkedAt: 1,
    }));
    await setAccountSettings(config, key, "anthropic", "a", { timezone: "Asia/Tokyo" });
    expect(await getAccountTimezone(config, key, "anthropic", "a", proxy, detect)).toMatchObject({
      override: "Asia/Tokyo",
      effective: "Asia/Tokyo",
      source: "manual",
    });
    expect(detect).not.toHaveBeenCalled();
    expect(await config.get("oauth.account_settings")).not.toContain("Tokyo");
    expect(await getAccountTimezone(config, key, "xai", "a", proxy, detect)).toMatchObject({
      override: null,
      effective: "America/New_York",
    });
    await setAccountSettings(config, key, "anthropic", "a", { timezone: undefined });
    expect(await getAccountTimezone(config, key, "anthropic", "a", proxy, detect)).toMatchObject({
      source: "ipapi.is",
    });
  });
});
