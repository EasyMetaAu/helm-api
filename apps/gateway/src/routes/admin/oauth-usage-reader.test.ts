import { describe, expect, it, vi } from "vitest";
import type { AdminApiDeps } from "./deps.js";
import { createOAuthUsageReader } from "./oauth-usage-reader.js";

describe("OAuth usage reader failure policy", () => {
  it("preserves local fail-open reads but fails the remote export explicitly", async () => {
    const deps = {
      oauthUsage: { queryRange: vi.fn().mockRejectedValue(new Error("db unavailable")) },
    } as unknown as AdminApiDeps;
    expect(await createOAuthUsageReader(deps).readUsage(0, null)).toEqual([]);
    await expect(createOAuthUsageReader(deps, false).readUsage(0, null)).rejects.toThrow(
      "db unavailable",
    );
  });
});
