import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkClientVersions,
  prepareRelease,
  releaseNeedsFreshness,
  SOURCES,
  syncClientVersions,
} from "./sync-client-versions.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "helm-client-versions-"));
  roots.push(root);
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config/claude-protocol-review.json"),
    JSON.stringify({
      schemaVersion: 1,
      cliVersion: "2.1.200",
      observedSdkVersion: "0.100.0",
      artifact: {
        name: "@anthropic-ai/claude-code-darwin-arm64",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        binarySha256: "a".repeat(64),
      },
      reviewedHeaders: ["anthropic-beta"],
      evidence: "docs/claude-protocol-safety.md",
    }),
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.30.36" }));
  return root;
}
const model = {
  slug: "test-model",
  display_name: "Test",
  supported_reasoning_levels: [],
  shell_type: "default",
  visibility: "list",
  supported_in_api: true,
  priority: 0,
  supports_reasoning_summaries: false,
  support_verbosity: false,
  truncation_policy: { mode: "tokens", limit: 1000 },
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [],
};
function upstream(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(init?.signal).toBeDefined();
    const values: Record<string, unknown> = {
      "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/2.1.200": {
        name: "@anthropic-ai/claude-code-darwin-arm64",
        version: "2.1.200",
        dist: { integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` },
      },
      [SOURCES.grok]: "1.0.46\n",
      [SOURCES.claude]: { name: "@anthropic-ai/claude-code", version: "2.1.200" },
      [SOURCES.codex]: { tag_name: "rust-v0.170.0", draft: false, prerelease: false },
      "https://raw.githubusercontent.com/openai/codex/rust-v0.170.0/codex-rs/models-manager/models.json":
        { models: [model] },
      ...overrides,
    };
    const value = values[url];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected URL ${url}`);
    return typeof value === "string" ? new Response(value) : Response.json(value);
  }) as unknown as typeof fetch;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("release client version snapshots", () => {
  it("pins three stable versions and the catalog from the SAME Codex tag; builds verify offline", async () => {
    const root = await fixture();
    const fetcher = upstream();
    await syncClientVersions({ root, fetcher });
    await expect(checkClientVersions({ root })).resolves.toBeUndefined();
    await expect(checkClientVersions({ root, fetcher, latest: true })).resolves.toBeUndefined();
    expect(
      await readFile(
        join(root, "packages/core/src/provider/oauth/grok-client-version.generated.ts"),
        "utf8",
      ),
    ).toContain('"1.0.46"');
    expect(
      await readFile(
        join(root, "packages/core/src/provider/oauth/codex-client-version.generated.ts"),
        "utf8",
      ),
    ).toContain('"0.170.0"');
  });
  it.each([
    { [SOURCES.claude]: { name: "@anthropic-ai/claude-code", version: "2.1.201" } },
    {
      "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/2.1.200": {
        name: "@anthropic-ai/claude-code-darwin-arm64",
        version: "2.1.200",
        dist: { integrity: "changed" },
      },
    },
    { [SOURCES.grok]: "1.0.46-alpha.1" },
    { [SOURCES.claude]: { name: "@anthropic-ai/claude-code", version: "2.1.200\nINJECT" } },
    { [SOURCES.codex]: { tag_name: "rust-v0.170.0", draft: false, prerelease: true } },
    {
      "https://raw.githubusercontent.com/openai/codex/rust-v0.170.0/codex-rs/models-manager/models.json":
        { models: [] },
    },
    { [SOURCES.grok]: new Error("timeout") },
  ])("leaves all pinned files and Helm version unchanged if any upstream is invalid", async (overrides) => {
    const root = await fixture();
    await syncClientVersions({ root, fetcher: upstream() });
    const before = await readFile(join(root, "config/generated/client-versions.json"), "utf8");
    await expect(
      prepareRelease("0.30.37", { root, fetcher: upstream(overrides) }),
    ).rejects.toThrow();
    expect(await readFile(join(root, "config/generated/client-versions.json"), "utf8")).toBe(
      before,
    );
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("0.30.36");
    await checkClientVersions({ root });
  });
  it("fails closed for stale stable versions without changing the snapshot", async () => {
    const root = await fixture();
    await syncClientVersions({ root, fetcher: upstream() });
    await expect(
      checkClientVersions({ root, fetcher: upstream({ [SOURCES.grok]: "1.0.47" }), latest: true }),
    ).rejects.toThrow(/stale/);
    await checkClientVersions({ root });
  });
  it("rejects catalog drift even if the manifest version still matches", async () => {
    const root = await fixture();
    await syncClientVersions({ root, fetcher: upstream() });
    await writeFile(
      join(root, "apps/gateway/src/oauth/codex-models.json"),
      JSON.stringify({ models: [] }),
    );
    await expect(checkClientVersions({ root })).rejects.toThrow(/mismatch/);
  });
  it("rejects downgrades and prereleases before querying upstream", async () => {
    const root = await fixture();
    const fetcher = vi.fn();
    for (const version of ["0.30.36", "0.30.35", "0.30.37-alpha.1"])
      await expect(
        prepareRelease(version, { root, fetcher: fetcher as typeof fetch }),
      ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bumps Helm version only after a valid snapshot is prepared", async () => {
    const root = await fixture();
    await prepareRelease("0.30.37", { root, fetcher: upstream() });
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("0.30.37");
    await checkClientVersions({ root });
  });
  it("requires freshness for an untagged version on ANY commit, including follow-ups", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 404 }));
    expect(await releaseNeedsFreshness("0.30.37", fetcher as typeof fetch)).toBe(true);
    expect(await releaseNeedsFreshness("0.30.37", fetcher as typeof fetch)).toBe(true);
    expect(
      await releaseNeedsFreshness(
        "0.30.36",
        vi.fn(async () => Response.json({ ref: "refs/tags/v0.30.36" })) as typeof fetch,
      ),
    ).toBe(false);
    await expect(
      releaseNeedsFreshness(
        "0.30.37",
        vi.fn(async () => new Response("", { status: 403 })) as typeof fetch,
      ),
    ).rejects.toThrow();
  });
});
