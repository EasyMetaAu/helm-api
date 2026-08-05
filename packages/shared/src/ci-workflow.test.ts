// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these assertions match
// literal shell/GitHub-Actions `${VAR}` interpolation inside the workflow YAML, not
// JS template literals (same rationale as compose.test.ts).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const ciPath = resolve(repoRoot, ".github/workflows/ci.yml");
const publishPath = resolve(repoRoot, ".github/workflows/publish.yml");

function jobBlock(raw: string, name: string): string {
  const start = raw.indexOf(`\n  ${name}:`);
  if (start < 0) return "";
  const remainder = raw.slice(start + 1);
  const nextJob = remainder.slice(1).search(/^ {2}[a-zA-Z0-9_-]+:/m);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob + 1);
}

function stepBlock(raw: string, name: string): string {
  const start = raw.indexOf(`\n      - name: ${name}`);
  if (start < 0) return "";
  const remainder = raw.slice(start + 1);
  const nextStep = remainder.slice(1).search(/^ {6}- (?:name:|uses:)/m);
  return nextStep < 0 ? remainder : remainder.slice(0, nextStep + 1);
}

describe("CI workflow", () => {
  const raw = readFileSync(ciPath, "utf8");

  it("runs the four quality gates: typecheck, lint, test, build", () => {
    for (const gate of ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm build"]) {
      expect(raw).toContain(gate);
    }
  });

  it("uses the default-branch workflow for pull requests and still runs on main pushes", () => {
    expect(raw).toContain("pull_request_target:");
    expect(raw).not.toMatch(/^\s{2}pull_request:/m);
    expect(raw).toMatch(/branches:\s*\[main\]/);
  });

  it("keeps CI permissions explicitly read-only", () => {
    const permissions = raw.slice(raw.indexOf("\npermissions:"), raw.indexOf("\njobs:"));
    expect(permissions).toContain("contents: read");
    expect(permissions).not.toContain("write");
    expect(raw.match(/^\s+checks:\s*write$/gm)).toHaveLength(1);
    for (const name of ["verify", "e2e", "docker"]) {
      expect(jobBlock(raw, name)).not.toMatch(/^\s+[a-z-]+:\s*write$/m);
    }
  });

  it("does not persist checkout credentials in any CI job", () => {
    expect(raw.match(/uses:\s*actions\/checkout@/g)).toHaveLength(3);
    expect(raw.match(/persist-credentials:\s*false/g)).toHaveLength(3);
  });

  it("installs with a frozen lockfile and does not swallow failures in the unit gate", () => {
    expect(raw).toContain("--frozen-lockfile");
    // Scope the "no swallowing" guard to the unit-gate `verify` job: its quality
    // gates must hard-fail. The docker job's teardown step may use
    // `continue-on-error` for cleanup without masking the smoke-test result.
    const verifyJob = raw.slice(raw.indexOf("\n  verify:"), raw.indexOf("\n  docker:"));
    expect(verifyJob).not.toContain("continue-on-error");
    expect(verifyJob).not.toContain("|| true");
  });

  it("has a separate docker job that builds and smoke-tests the gateway image", () => {
    // A dedicated job (independent of the unit-gate `verify` job) that exercises
    // the real Docker image — closes the "Docker not actually built/run in this
    // env" gap by moving build/run verification to CI (docs/10).
    expect(raw).toMatch(/^\s{2}docker:/m);
    expect(raw).toContain("docker build");
    expect(raw).toContain("docker run");
    // Boots with the required provider credential env and hits /healthz.
    expect(raw).toContain("DEEPSEEK_API_KEY");
    expect(raw).toContain("/healthz");
    // Cleans the container up afterwards.
    expect(raw).toContain("docker stop");
  });

  it("keeps the docker job independent so the unit gates run on their own", () => {
    // The docker job must NOT block the four quality gates: no `needs: verify`
    // (or any needs) chaining it onto the unit-gate job.
    const dockerJob = jobBlock(raw, "docker");
    expect(dockerJob).not.toMatch(/needs:/);
  });

  it("fetches both parents before validating a pull-request merge ref", () => {
    expect(raw.match(/fetch-depth:\s*2/g)).toHaveLength(3);
  });

  it("keeps pull requests on the trusted default-branch workflow and off the persistent pool", () => {
    for (const name of ["verify", "e2e", "docker"]) {
      const job = jobBlock(raw, name);
      expect(job, `${name} job must exist`).not.toBe("");
      expect(job).toContain("github.event_name == 'pull_request_target'");
      expect(job).toContain('["ubuntu-24.04"]');
      expect(job).toContain('["self-hosted","Linux","X64","docker"]');
      expect(job).toContain("refs/pull/{0}/merge");
      expect(job).toContain("fetch-depth: 2");
      expect(job).toContain(
        "allow-unsafe-pr-checkout: $" + "{{ github.event_name == 'pull_request_target' }}",
      );
      expect(job).toContain("Verify PR merge ref matches event head");
      expect(job).toContain("github.event.pull_request.head.sha");
    }
  });

  it("reports immutable PR-head checks from a separate trusted job", () => {
    const report = jobBlock(raw, "report_pr_checks");
    expect(report).toContain("if: always() && github.event_name == 'pull_request_target'");
    expect(report).toContain("needs: [verify, e2e, docker]");
    expect(report).toContain("runs-on: ubuntu-24.04");
    expect(report).toContain("checks: write");
    expect(report).toContain("github.event.pull_request.head.sha");
    for (const context of ["PR / verify", "PR / e2e", "PR / docker"]) {
      expect(report).toContain(context);
    }
    expect(report).not.toContain("actions/checkout@");
  });

  it("disables package-manager caching explicitly without enabling pnpm cache", () => {
    expect(raw.match(/package-manager-cache:\s*false/g)).toHaveLength(2);
    expect(raw).not.toMatch(/^\s+cache:\s*(?:pnpm|true)\s*$/m);
  });
});

describe("release workflow policy", () => {
  const ciRaw = readFileSync(ciPath, "utf8");
  const publishRaw = readFileSync(publishPath, "utf8");

  it("pins every external action and reusable workflow to an approved full commit SHA", () => {
    const expectedPins = new Map([
      ["actions/checkout", "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"],
      ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
      ["pnpm/action-setup", "0ebf47130e4866e96fce0953f49152a61190b271"],
    ]);

    const uses = [
      ...`${ciRaw}\n${publishRaw}`.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s*#.*)?$/gm),
    ].flatMap((match) => (match[1] ? [match[1]] : []));
    const externalUses = uses.filter((entry) => !entry.startsWith("./"));
    expect(externalUses.length).toBeGreaterThan(0);
    for (const entry of externalUses) {
      expect(entry).toMatch(/@[0-9a-f]{40}$/);
    }
    const actionNames = new Set(
      externalUses.map((entry) => entry.slice(0, entry.lastIndexOf("@"))),
    );
    expect(actionNames).toEqual(new Set(expectedPins.keys()));
    for (const [action, sha] of expectedPins) {
      const matchingUses = externalUses.filter((entry) => entry.startsWith(`${action}@`));
      expect(matchingUses.length, `${action} must remain in the workflows`).toBeGreaterThan(0);
      expect(new Set(matchingUses)).toEqual(new Set([`${action}@${sha}`]));
    }
  });

  it("never enables unsafe PR checkout in the privileged publish workflow", () => {
    expect(publishRaw).not.toContain("allow-unsafe-pr-checkout");
  });

  it("keeps GHCR publishing off the self-hosted runner egress", () => {
    const publishJob = jobBlock(publishRaw, "publish");
    expect(publishJob).toContain("runs-on: ubuntu-24.04");
    expect(publishJob).not.toContain("runs-on: [self-hosted, Linux, X64, docker]");
  });

  it("keeps the package-write Docker credential run-scoped", () => {
    const publishJob = jobBlock(publishRaw, "publish");
    const jobHeader = publishJob.slice(0, publishJob.indexOf("\n    steps:"));
    expect(jobHeader).not.toMatch(/\$\{\{\s*runner\./);

    const setupStep = stepBlock(publishRaw, "Configure run-scoped registry credentials");
    expect(setupStep).toContain("DOCKER_CONFIG=${RUNNER_TEMP}/helm-publish-docker-");
    expect(setupStep).toContain("${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}");
    expect(setupStep).toContain('>> "${GITHUB_ENV}"');

    const cleanupStep = stepBlock(publishRaw, "Remove run-scoped registry credentials");
    expect(cleanupStep).toContain("if: always()");
    expect(cleanupStep).toContain('rm -rf -- "${DOCKER_CONFIG}"');

    const setupIndex = publishJob.indexOf("- name: Configure run-scoped registry credentials");
    const loginIndex = publishJob.indexOf("- name: Log in to GHCR");
    const cleanupIndex = publishJob.indexOf("- name: Remove run-scoped registry credentials");
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeLessThan(loginIndex);
    expect(cleanupIndex).toBeGreaterThan(publishJob.lastIndexOf("docker "));
  });

  it("publishes only after the CI workflow succeeds for a main push", () => {
    const trigger = publishRaw.slice(
      publishRaw.indexOf("\non:"),
      publishRaw.indexOf("\nconcurrency:"),
    );
    expect(trigger).toContain("workflow_run:");
    expect(trigger).toContain('workflows: ["CI"]');
    expect(trigger).toContain("types: [completed]");
    expect(trigger).toContain("branches: [main]");
    expect(trigger).not.toMatch(/^\s+push:/m);

    const publishJob = jobBlock(publishRaw, "publish");
    expect(publishJob).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(publishJob).toContain("github.event.workflow_run.event == 'push'");
    expect(publishJob).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  it("keeps ineligible workflow runs out of the privileged writer concurrency group", () => {
    const concurrency = publishRaw.slice(
      publishRaw.indexOf("\nconcurrency:"),
      publishRaw.indexOf("\njobs:"),
    );
    expect(concurrency).toContain("github.event.workflow_run.event == 'push'");
    expect(concurrency).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(concurrency).toContain("publish-ineligible-");
    expect(concurrency).toContain("github.run_id");
    expect(concurrency).not.toMatch(/^\s+group:\s*publish-main\s*$/m);
  });

  it("checks out the CI-verified commit and derives deterministic full-SHA metadata", () => {
    const dollar = "$";
    expect(publishRaw).toContain(`ref: ${dollar}{{ github.event.workflow_run.head_sha }}`);
    expect(publishRaw).toContain("persist-credentials: false");
    expect(publishRaw).toContain(`full_sha=${dollar}{FULL_SHA}`);
    expect(publishRaw).toContain(`IMMUTABLE_TAG="${dollar}{IMAGE}:sha-${dollar}{FULL_SHA}"`);
    expect(publishRaw).not.toContain(`IMMUTABLE_TAG="${dollar}{IMAGE}:sha-${dollar}{SHA}"`);
    expect(publishRaw).toContain(`git show -s --format=%ct "${dollar}{FULL_SHA}"`);
    expect(publishRaw).toContain("unsafe package version");
    expect(publishRaw).toContain("workflow and checkout SHAs must be 40 lowercase hex characters");
    expect(publishRaw).toContain("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$");
    expect(publishRaw).toContain(`source_date_epoch=${dollar}{COMMIT_EPOCH}`);
    expect(publishRaw).toContain(`--build-arg SOURCE_DATE_EPOCH="${dollar}{SOURCE_DATE_EPOCH}"`);
    expect(publishRaw).not.toContain("BUILT_AT=$(date");
    expect(publishRaw).toContain(
      `target_commitish\\":\\"${dollar}{{ steps.release_state.outputs.release_sha }}`,
    );
    expect(publishRaw).not.toContain(`target_commitish\\":\\"${dollar}{GITHUB_SHA}`);
  });

  it("reuses an existing immutable image and only builds when the full-SHA tag is absent", () => {
    const dollar = "$";
    const checkStep = stepBlock(publishRaw, "Check immutable image");
    expect(checkStep).toContain("docker manifest inspect");
    expect(checkStep).toContain('echo "exists=true"');
    expect(checkStep).toContain('echo "exists=false"');
    expect(checkStep).toContain("manifest unknown|no such manifest");

    const buildStep = stepBlock(publishRaw, "Build immutable image");
    expect(buildStep).toContain("steps.image.outputs.exists == 'false'");
    expect(buildStep).toContain(`--tag "${dollar}{{ steps.meta.outputs.immutable_tag }}"`);
    expect(buildStep).toContain("org.opencontainers.image.revision");
    expect(buildStep).toContain("org.opencontainers.image.created");
    expect(buildStep).not.toContain("version_tag");
    expect(buildStep).not.toContain("latest_tag");

    const immutableStep = stepBlock(publishRaw, "Push immutable image");
    expect(immutableStep).toContain("steps.image.outputs.exists == 'false'");
    expect(immutableStep).toContain("docker manifest inspect");
    expect(immutableStep).toContain("appeared while building; do not overwrite it");
    expect(immutableStep).toContain('docker push "${IMMUTABLE_TAG}"');
    expect(immutableStep).not.toContain("latest_tag");
    expect(immutableStep).not.toContain("version_tag");

    const verifyStep = stepBlock(publishRaw, "Verify immutable image");
    expect(verifyStep).toContain('docker pull "${IMMUTABLE_TAG}"');
    expect(verifyStep).toContain("org.opencontainers.image.revision");
    expect(verifyStep).toContain("org.opencontainers.image.version");
    expect(verifyStep).toContain("org.opencontainers.image.created");
    expect(verifyStep).toContain('echo "digest_ref=${IMAGE}@${DIGEST}"');
  });

  it("retries transient manifest lookups without treating missing tags as errors", () => {
    expect(publishRaw.match(/docker manifest inspect/g)).toHaveLength(5);

    for (const name of [
      "Check immutable image",
      "Push immutable image",
      "Resolve effective release image",
      "Promote release tag",
      "Promote latest tag",
    ]) {
      const step = stepBlock(publishRaw, name);
      expect(step, `${name} step must exist`).not.toBe("");
      expect(step).toContain("for attempt in 1 2 3");
      expect(step).toContain("sleep 2");
      expect(step.indexOf("manifest unknown|no such manifest")).toBeLessThan(
        step.indexOf("sleep 2"),
      );
      expect(step).toMatch(/(?:exit 1|return 2)/);
    }

    for (const name of ["Check immutable image", "Push immutable image"]) {
      expect(stepBlock(publishRaw, name)).toMatch(/IMAGE_STATE=missing\s+break/);
    }
    expect(stepBlock(publishRaw, "Resolve effective release image")).toMatch(
      /VERSION_EXISTS=false\s+break/,
    );
    for (const name of ["Promote release tag", "Promote latest tag"]) {
      expect(stepBlock(publishRaw, name)).toMatch(
        /manifest unknown\|no such manifest[\s\S]+return 1/,
      );
    }
  });

  it("fails closed when the git tag and GitHub Release disagree", () => {
    const metaStep = stepBlock(publishRaw, "Resolve release state + deterministic build info");
    expect(metaStep).toContain("/releases/tags/v${VERSION}");
    expect(metaStep).toContain("TAG_EXISTS");
    expect(metaStep).toContain("RELEASE_EXISTS");
    expect(metaStep).toContain("git tag exists but the GitHub Release is missing");
    expect(metaStep).toContain("GitHub Release exists but its git tag is missing");
    expect(metaStep).toContain("draft Release");
    expect(metaStep).toContain("git merge-base --is-ancestor");
  });

  it("requires an existing Release to retain a matching semver image", () => {
    const step = stepBlock(publishRaw, "Resolve effective release image");
    expect(step).toContain('if [ "${INITIAL_RELEASE}" = "false" ]');
    expect(step).toContain('pull_digest "${TARGET_TAG}"');
    expect(step).toContain("HELM_VERSION");
    expect(step).toContain("HELM_GIT_SHA");
    expect(step).toContain("org.opencontainers.image.revision");
    expect(step).toContain('if [ -z "${IMAGE_REVISION}" ]');
    expect(step).toContain('"${IMAGE_SHA}" =~ ^[0-9a-f]{7,40}$');
    expect(step).toContain('git rev-parse --verify "${IMAGE_SHA}^{commit}"');
    expect(step).toContain('"${RESOLVED_LEGACY_SHA}" != "${RELEASE_SHA}"');
    expect(step).toContain('IMMUTABLE_TAG="${IMAGE}:sha-${RELEASE_SHA}"');
    expect(step).toContain('"${VERSION_DIGEST}" != "${IMMUTABLE_DIGEST}"');
  });

  it("reconciles only a verifiable interrupted release on a main ancestor", () => {
    const step = stepBlock(publishRaw, "Resolve effective release image");
    expect(step).toContain("possible interrupted release");
    expect(step).toContain("^[0-9a-f]{40}$");
    expect(step).toContain('"${IMAGE_REVISION}" != "${CANDIDATE_SHA}"');
    expect(step).toContain("HELM_BUILT_AT");
    expect(step).toContain("org.opencontainers.image.created");
    expect(step).toContain('"${IMAGE_CREATED}" != "${EXPECTED_BUILT_AT}"');
    expect(step).toContain('git cat-file -e "${CANDIDATE_SHA}^{commit}"');
    expect(step).toContain('git merge-base --is-ancestor "${CANDIDATE_SHA}" "${CURRENT_SHA}"');
    expect(step).toContain('git show "${CANDIDATE_SHA}:package.json"');
    expect(step).toContain('"${CANDIDATE_VERSION}" != "${VERSION}"');
    expect(step).toContain('CANDIDATE_TAG="${IMAGE}:sha-${CANDIDATE_SHA}"');
    expect(step).toContain('"${VERSION_DIGEST}" != "${CANDIDATE_DIGEST}"');
    expect(step).toContain(
      'emit_state true "${CANDIDATE_SHA}" "${CANDIDATE_DIGEST}" "${CANDIDATE_REF}" true true',
    );
  });

  it("promotes semver and latest from the exact immutable digest and verifies the result", () => {
    for (const name of ["Promote release tag", "Promote latest tag"]) {
      const step = stepBlock(publishRaw, name);
      expect(step, `${name} step must exist`).not.toBe("");
      expect(step).toContain('docker pull "${IMMUTABLE_REF}"');
      expect(step).toContain('docker tag "${IMMUTABLE_REF}" "${TARGET_TAG}"');
      expect(step).toContain('docker push "${TARGET_TAG}"');
      expect(step).toContain('"${TARGET_DIGEST}" != "${IMMUTABLE_DIGEST}"');
    }

    const versionStep = stepBlock(publishRaw, "Promote release tag");
    expect(versionStep).toContain("steps.release_state.outputs.immutable_ref");
    expect(versionStep).toContain("docker manifest inspect");
    expect(versionStep).toContain("already points at the immutable digest; reusing it");
    expect(versionStep.indexOf("docker manifest inspect")).toBeLessThan(
      versionStep.indexOf('docker tag "${IMMUTABLE_REF}" "${TARGET_TAG}"'),
    );
    const latestStep = stepBlock(publishRaw, "Promote latest tag");
    expect(latestStep).toContain("steps.immutable.outputs.digest_ref");
  });

  it("retries a partial release without overwriting a conflicting semver tag", () => {
    const metaStep = stepBlock(publishRaw, "Resolve release state + deterministic build info");
    expect(metaStep).toContain('[ "${TAG_EXISTS}" = "false" ]');
    expect(metaStep).toContain('[ "${RELEASE_EXISTS}" = "true" ]');
    expect(metaStep).toContain("RELEASE=true");

    const versionStep = stepBlock(publishRaw, "Promote release tag");
    expect(versionStep).toContain("refusing to overwrite ${TARGET_TAG}");
    expect(versionStep).toContain("already points at the immutable digest; reusing it");
    expect(versionStep.indexOf("refusing to overwrite ${TARGET_TAG}")).toBeLessThan(
      versionStep.indexOf('docker push "${TARGET_TAG}"'),
    );

    const releaseStep = stepBlock(publishRaw, "Cut GitHub Release");
    expect(releaseStep).toContain("steps.version.outputs.current == 'true'");
    expect(releaseStep).toContain("would leave a version image with no matching Release");
  });

  it("rechecks main at mutable boundaries and finishes in-flight releases", () => {
    const dollar = "$";
    expect(publishRaw).toContain("id: head");
    const versionStep = stepBlock(publishRaw, "Promote release tag");
    const latestStep = stepBlock(publishRaw, "Promote latest tag");
    expect(versionStep).toContain("git ls-remote --exit-code origin refs/heads/main");
    expect(versionStep).toContain("current=false");
    expect(latestStep).toContain("git ls-remote --exit-code origin refs/heads/main");
    expect(latestStep).toContain("current=false");

    const releaseStep = stepBlock(publishRaw, "Cut GitHub Release");
    expect(releaseStep).toContain("steps.version.outputs.current == 'true'");
    expect(releaseStep).toContain(
      `target_commitish\\":\\"${dollar}{{ steps.release_state.outputs.release_sha }}`,
    );
    expect(releaseStep).not.toContain(`target_commitish\\":\\"${dollar}{GITHUB_SHA}`);
    expect(releaseStep).not.toContain("refs/heads/main");

    expect(publishRaw.indexOf("- name: Promote release tag")).toBeLessThan(
      publishRaw.indexOf("- name: Cut GitHub Release"),
    );
    expect(publishRaw.indexOf("- name: Cut GitHub Release")).toBeLessThan(
      publishRaw.indexOf("- name: Promote latest tag"),
    );
  });

  it("documents the unavoidable non-atomic GitHub-to-GHCR boundary", () => {
    expect(publishRaw).toContain("GitHub and GHCR writes are not atomic");
    expect(publishRaw).toContain("cannot make the remote main check and registry write atomic");
    const summaryStep = stepBlock(publishRaw, "Summary");
    expect(summaryStep).toContain("steps.release_state.outputs.version_reused");
    expect(summaryStep).not.toContain("steps.version.outputs.reused");
  });
});
