import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const Version = z.string().regex(/^\d+\.\d+\.\d+$/);
export const ClaudeProtocolReviewSchema = z.object({
  schemaVersion: z.literal(1),
  cliVersion: Version,
  observedSdkVersion: Version,
  artifact: z.object({
    name: z.literal("@anthropic-ai/claude-code-darwin-arm64"),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  reviewedHeaders: z.array(z.string().regex(/^[a-z][a-z0-9-]+$/)).min(1),
  evidence: z.literal("docs/claude-protocol-safety.md"),
});

/** Review is separate from version discovery. Never execute a downloaded CLI or
 * automatically expand the trusted header set when a new release appears. */
export async function checkClaudeProtocolReview(
  options: { root?: string; cliVersion?: string; offline?: boolean; fetcher?: typeof fetch } = {},
): Promise<void> {
  const review = ClaudeProtocolReviewSchema.parse(
    JSON.parse(
      await readFile(
        resolve(options.root ?? process.cwd(), "config/claude-protocol-review.json"),
        "utf8",
      ),
    ),
  );
  if (options.offline) return;
  if (options.cliVersion !== review.cliVersion) {
    throw new Error(
      "Claude protocol review required before accepting this CLI release; updating a version string is insufficient",
    );
  }
  const response = await (options.fetcher ?? fetch)(
    `https://registry.npmjs.org/${review.artifact.name}/${review.cliVersion}`,
    {
      headers: { Accept: "application/json", "User-Agent": "helm-api-protocol-review" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(`Claude protocol artifact lookup failed: HTTP ${response.status}`);
  const artifact = z
    .object({
      name: z.literal(review.artifact.name),
      version: z.literal(review.cliVersion),
      dist: z.object({ integrity: z.literal(review.artifact.integrity) }),
    })
    .safeParse(await response.json());
  if (!artifact.success)
    throw new Error(
      "Reviewed Claude protocol artifact changed; inspect and review the release again",
    );
}
