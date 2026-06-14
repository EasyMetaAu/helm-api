import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Mode = "claude-cli" | "codex-cli";

type Assertion = {
  name: string;
  passed: boolean;
  details?: string;
};

type CliReport = {
  cli: Mode;
  version: string | null;
  helmBaseUrl: string | null;
  traceId: string | null;
  providerAlias: string | null;
  providerModel: string | null;
  nativePassthrough: boolean | null;
  mutationLedger: Record<string, unknown> | null;
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  dryRun: boolean;
  assertions: Assertion[];
};

type LiveReport = {
  generatedAt: string;
  status: "passed" | "failed" | "dry-run";
  reports: CliReport[];
};

const REPORT_PATH = resolve("artifacts/passthrough-live-report.json");
const DRY_RUN_ENV = "HELM_PASSTHROUGH_LIVE_DRY_RUN";
const COMMON_REQUIRED_ENV = ["HELM_PASSTHROUGH_BASE_URL", "HELM_PASSTHROUGH_API_KEY"];
const ASSERTIONS_FILE_ENV = "HELM_PASSTHROUGH_LIVE_ASSERTIONS_FILE";
const EXPECTED_OUTPUT_ENV = "HELM_PASSTHROUGH_EXPECTED_OUTPUT";
const CLI_CONFIG: Record<Mode, { binary: string; commandEnv: string; protocol: string }> = {
  "claude-cli": {
    binary: "claude",
    commandEnv: "HELM_PASSTHROUGH_CLAUDE_COMMAND",
    protocol: "anthropic_messages",
  },
  "codex-cli": {
    binary: "codex",
    commandEnv: "HELM_PASSTHROUGH_CODEX_COMMAND",
    protocol: "openai_responses",
  },
};

function summarize(value: string, limit = 1_000): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}...`;
}

function secretEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => {
      if (!value || value.length < 4) return false;
      return /(key|token|secret|password|credential|authorization|auth|basic)/i.test(key);
    })
    .map(([, value]) => value as string)
    .filter((value, index, all) => all.indexOf(value) === index);
}

export function summarizeCliOutput(value: string, expectedOutput: string): string {
  const bytes = Buffer.byteLength(value);
  const lines = value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  const redacted = secretEnvValues().reduce(
    (text, secret) => text.split(secret).join("[redacted]"),
    value,
  );
  const leakedSecret = redacted !== value;
  const sentinelPresent = value.includes(expectedOutput);
  return [
    "redacted output summary",
    `bytes:${bytes}`,
    `lines:${lines}`,
    `sha256:${digest}`,
    `sentinel_present:${sentinelPresent}`,
    `secret_redacted:${leakedSecret}`,
  ].join(", ");
}

function assertionEvidenceFor(mode: Mode): Record<string, unknown> | null {
  const file = process.env[ASSERTIONS_FILE_ENV];
  if (!file) return null;
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const direct = parsed[mode];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const reports = parsed.reports;
  if (Array.isArray(reports)) {
    const found = reports.find(
      (item): item is Record<string, unknown> =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.cli === mode,
    );
    return found ?? null;
  }
  return null;
}

function applyTelemetryEvidence(report: CliReport, evidence: Record<string, unknown> | null): boolean {
  if (evidence === null) return false;
  if (typeof evidence.traceId === "string") report.traceId = evidence.traceId;
  if (typeof evidence.trace_id === "string") report.traceId = evidence.trace_id;
  if (typeof evidence.providerAlias === "string") report.providerAlias = evidence.providerAlias;
  if (typeof evidence.provider_name === "string") report.providerAlias = evidence.provider_name;
  if (typeof evidence.providerModel === "string") report.providerModel = evidence.providerModel;
  if (typeof evidence.provider_model === "string") report.providerModel = evidence.provider_model;
  if (typeof evidence.nativePassthrough === "boolean") {
    report.nativePassthrough = evidence.nativePassthrough;
  }
  if (typeof evidence.passthrough_used === "boolean") {
    report.nativePassthrough = evidence.passthrough_used;
  }
  const ledger = evidence.mutationLedger ?? evidence.passthrough_mutations;
  if (ledger && typeof ledger === "object" && !Array.isArray(ledger)) {
    report.mutationLedger = ledger as Record<string, unknown>;
  }
  return report.nativePassthrough === true;
}

function commandExists(binary: string): { exists: boolean; version: string | null; stderr: string } {
  const which = spawnSync("which", [binary], { encoding: "utf8" });
  if (which.status !== 0) {
    return { exists: false, version: null, stderr: summarize(which.stderr) };
  }
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 });
  return {
    exists: true,
    version: summarize(version.stdout || version.stderr) || null,
    stderr: summarize(version.stderr),
  };
}

function baseReport(mode: Mode, dryRun: boolean): CliReport {
  return {
    cli: mode,
    version: null,
    helmBaseUrl: process.env.HELM_PASSTHROUGH_BASE_URL ?? null,
    traceId: null,
    providerAlias: process.env[`HELM_PASSTHROUGH_${mode === "claude-cli" ? "CLAUDE" : "CODEX"}_PROVIDER_ALIAS`] ?? null,
    providerModel: process.env[`HELM_PASSTHROUGH_${mode === "claude-cli" ? "CLAUDE" : "CODEX"}_MODEL`] ?? null,
    nativePassthrough: null,
    mutationLedger: null,
    exitCode: null,
    stdoutSummary: "",
    stderrSummary: "",
    dryRun,
    assertions: [],
  };
}

function addAssertion(report: CliReport, name: string, passed: boolean, details?: string): void {
  report.assertions.push({ name, passed, ...(details ? { details } : {}) });
}

function adminBaseUrl(): string | null {
  return process.env.HELM_PASSTHROUGH_ADMIN_BASE_URL ?? process.env.HELM_PASSTHROUGH_BASE_URL ?? null;
}

function adminHeaders(): Record<string, string> {
  const basic = process.env.HELM_PASSTHROUGH_ADMIN_BASIC;
  if (!basic) return {};
  return {
    authorization: basic.startsWith("Basic ")
      ? basic
      : `Basic ${Buffer.from(basic).toString("base64")}`,
  };
}

function attemptMatchesProtocol(attempt: unknown, protocol: string): boolean {
  const record = attempt as Record<string, unknown>;
  return (
    record.passthrough_used === true &&
    record.source_protocol === protocol &&
    record.response_protocol === protocol
  );
}

async function fetchAdminJson(path: string): Promise<unknown> {
  const base = adminBaseUrl();
  if (!base) throw new Error("missing HELM_PASSTHROUGH_ADMIN_BASE_URL/HELM_PASSTHROUGH_BASE_URL");
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { headers: adminHeaders() });
  if (!res.ok) throw new Error(`admin ${path} returned HTTP ${res.status}`);
  return await res.json();
}

async function telemetryEvidenceFromAdmin(
  traceId: string | null,
  protocol: string,
): Promise<Record<string, unknown> | null> {
  let detail: Record<string, unknown> | null = null;
  if (traceId) {
    detail = (await fetchAdminJson(`/admin/api/requests/${encodeURIComponent(traceId)}`)) as Record<
      string,
      unknown
    >;
  } else {
    const page = (await fetchAdminJson("/admin/api/requests?pageSize=20")) as { items?: unknown[] };
    detail =
      ((page.items ?? []).find((item) =>
        ((item as { provider_attempts?: unknown[] }).provider_attempts ?? []).some((attempt) =>
          attemptMatchesProtocol(attempt, protocol),
        ),
      ) as Record<string, unknown> | undefined) ?? null;
  }
  if (detail === null) return null;
  const attempts = (detail.provider_attempts as unknown[] | undefined) ?? [];
  const attempt = attempts.find((a) => attemptMatchesProtocol(a, protocol)) as
    | Record<string, unknown>
    | undefined;
  if (!attempt) return null;
  return {
    traceId: detail.trace_id,
    providerAlias: attempt.provider_name,
    providerModel: attempt.provider_model,
    nativePassthrough: true,
    mutationLedger: attempt.passthrough_mutations ?? null,
  };
}

function traceFromText(text: string): string | null {
  const traceMatch = text.match(/trace[_ -]?id[=: ]+([a-zA-Z0-9_-]+)/i);
  return traceMatch?.[1] ?? null;
}

async function runMode(mode: Mode, dryRun: boolean): Promise<CliReport> {
  const config = CLI_CONFIG[mode];
  const report = baseReport(mode, dryRun);
  const binary = commandExists(config.binary);
  report.version = binary.version;
  addAssertion(report, `${config.binary} binary is installed`, binary.exists, binary.stderr);

  const missingEnv = COMMON_REQUIRED_ENV.filter((name) => !process.env[name]);
  const commandTemplate = process.env[config.commandEnv];
  if (!commandTemplate) missingEnv.push(config.commandEnv);
  addAssertion(
    report,
    "required live environment is configured",
    missingEnv.length === 0,
    missingEnv.length > 0 ? `missing: ${missingEnv.join(", ")}` : undefined,
  );

  if (dryRun) {
    report.exitCode = 0;
    report.stdoutSummary = `dry-run only; set ${DRY_RUN_ENV}=0 to execute ${config.binary}`;
    report.nativePassthrough = null;
    addAssertion(report, "dry-run explicitly enabled", true);
    return report;
  }

  if (!binary.exists || missingEnv.length > 0 || !commandTemplate) {
    report.exitCode = 1;
    addAssertion(report, "live CLI execution completed", false, "preflight failed");
    addAssertion(
      report,
      `telemetry proves ${config.protocol} native passthrough`,
      false,
      "not checked because preflight failed",
    );
    return report;
  }

  const expected = process.env[EXPECTED_OUTPUT_ENV] ?? "HELM_LIVE_OK";
  const child = spawnSync(commandTemplate, {
    shell: true,
    encoding: "utf8",
    timeout: Number(process.env.HELM_PASSTHROUGH_LIVE_TIMEOUT_MS ?? "120000"),
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: process.env.HELM_PASSTHROUGH_BASE_URL,
      ANTHROPIC_API_KEY: process.env.HELM_PASSTHROUGH_API_KEY,
      OPENAI_BASE_URL: process.env.HELM_PASSTHROUGH_BASE_URL,
      OPENAI_API_KEY: process.env.HELM_PASSTHROUGH_API_KEY,
    },
  });
  report.exitCode = child.status ?? 1;
  report.stdoutSummary = summarizeCliOutput(child.stdout, expected);
  report.stderrSummary = summarizeCliOutput(child.stderr || child.error?.message || "", expected);
  addAssertion(report, "live CLI execution completed", report.exitCode === 0);
  addAssertion(
    report,
    "live CLI returned the expected sentinel",
    `${child.stdout}\n${child.stderr}`.includes(expected),
    `expected output marker length: ${expected.length}`,
  );

  report.traceId = traceFromText(`${child.stdout}\n${child.stderr}`);
  const evidence =
    assertionEvidenceFor(mode) ?? (await telemetryEvidenceFromAdmin(report.traceId, config.protocol).catch(() => null));
  const telemetryPassed = applyTelemetryEvidence(report, evidence);
  addAssertion(
    report,
    "trace id was discoverable",
    report.traceId !== null,
    report.traceId === null ? `missing trace; provide ${ASSERTIONS_FILE_ENV}` : undefined,
  );
  addAssertion(
    report,
    `telemetry proves ${config.protocol} native passthrough`,
    telemetryPassed,
    telemetryPassed ? undefined : `missing nativePassthrough:true evidence in ${ASSERTIONS_FILE_ENV}`,
  );
  const serializedEvidence = JSON.stringify(evidence ?? {});
  const leakedKey = process.env.HELM_PASSTHROUGH_API_KEY
    ? serializedEvidence.includes(process.env.HELM_PASSTHROUGH_API_KEY)
    : false;
  addAssertion(report, "telemetry evidence does not contain Helm API key", !leakedKey);
  return report;
}

function writeReport(report: LiveReport): void {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

function selectedModes(arg: string | undefined): Mode[] {
  if (arg === "claude-cli" || arg === "codex-cli") return [arg];
  if (arg === "all" || arg === undefined) return ["claude-cli", "codex-cli"];
  throw new Error(`unknown passthrough live mode: ${arg}`);
}

async function main(): Promise<void> {
  const dryRun = process.env[DRY_RUN_ENV] === "1" || process.env[DRY_RUN_ENV] === "true";
  const reports = await Promise.all(
    selectedModes(process.argv[2]).map((mode) => runMode(mode, dryRun)),
  );
  const allPassed = reports.every((report) => report.assertions.every((a) => a.passed));
  const liveReport: LiveReport = {
    generatedAt: new Date().toISOString(),
    status: dryRun ? "dry-run" : allPassed ? "passed" : "failed",
    reports,
  };
  writeReport(liveReport);
  console.log(`wrote ${REPORT_PATH}`);
  if (!dryRun && !allPassed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: LiveReport = {
      generatedAt: new Date().toISOString(),
      status: "failed",
      reports: [],
    };
    writeReport(failed);
    console.error(message);
    process.exitCode = 1;
  }
}
