import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkClaudeProtocolReview } from "./claude-protocol-review.js";

const roots: string[] = [];
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const review = {
  schemaVersion: 1,
  cliVersion: "2.1.295",
  observedSdkVersion: "0.128.0",
  artifact: {
    name: "@anthropic-ai/claude-code-darwin-arm64",
    integrity,
    binarySha256: "a".repeat(64),
  },
  reviewedHeaders: ["anthropic-version", "anthropic-beta", "x-anthropic-additional-protection"],
  evidence: "docs/claude-protocol-safety.md",
};
async function fixture(value: unknown = review) {
  const root = await mkdtemp(join(tmpdir(), "helm-claude-review-"));
  roots.push(root);
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/claude-protocol-review.json"), JSON.stringify(value));
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
describe("Claude protocol review gate", () => {
  it("verifies a reviewed release artifact independently of its CLI version", async () => {
    const root = await fixture();
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      Response.json({
        name: review.artifact.name,
        version: review.cliVersion,
        dist: { integrity },
      }),
    );
    await checkClaudeProtocolReview({ root, cliVersion: review.cliVersion, fetcher });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/2.1.295",
    );
    await expect(
      checkClaudeProtocolReview({
        root,
        cliVersion: review.cliVersion,
        fetcher: async () =>
          Response.json({
            name: review.artifact.name,
            version: review.cliVersion,
            dist: { integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}` },
          }),
      }),
    ).rejects.toThrow(/artifact changed/);
  });
  it("blocks an unreviewed CLI upgrade before any artifact fetch", async () => {
    const root = await fixture();
    const fetcher = vi.fn();
    await expect(
      checkClaudeProtocolReview({ root, cliVersion: "2.1.296", fetcher }),
    ).rejects.toThrow(/protocol review/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("validates the offline contract and rejects malformed provenance", async () => {
    await expect(
      checkClaudeProtocolReview({ root: await fixture(), offline: true }),
    ).resolves.toBeUndefined();
    await expect(
      checkClaudeProtocolReview({
        root: await fixture({
          ...review,
          artifact: { ...review.artifact, integrity: "unverified" },
        }),
        offline: true,
      }),
    ).rejects.toThrow();
  });
});
