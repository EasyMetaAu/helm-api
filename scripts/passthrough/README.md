# Native Passthrough Acceptance Scripts

Deterministic checks do not require real provider credentials:

```bash
pnpm test:passthrough:unit
pnpm test:passthrough:e2e
pnpm test:passthrough
```

Live checks are intentionally fail-closed. They create `artifacts/passthrough-live-report.json` and fail unless the real CLI binary and required local Helm environment are present:

- `HELM_PASSTHROUGH_BASE_URL` - local Helm base URL used by the CLI.
- `HELM_PASSTHROUGH_API_KEY` - local Helm API key passed to the CLI environment.
- `HELM_PASSTHROUGH_ADMIN_BASE_URL` - optional admin/API base URL for telemetry checks; defaults to `HELM_PASSTHROUGH_BASE_URL`.
- `HELM_PASSTHROUGH_ADMIN_BASIC` - optional Basic auth value for `/admin/api/requests`.
- `HELM_PASSTHROUGH_CLAUDE_COMMAND` - shell command that invokes the installed `claude` CLI against the local Helm instance.
- `HELM_PASSTHROUGH_CODEX_COMMAND` - shell command that invokes the installed `codex` CLI against the local Helm instance.
- `HELM_PASSTHROUGH_LIVE_ASSERTIONS_FILE` - optional telemetry JSON if admin access is not exposed to the script. It must contain either a top-level `claude-cli` / `codex-cli` object or a `reports[]` entry with `nativePassthrough: true`, plus optional `traceId`, `providerAlias`, `providerModel`, and `mutationLedger`.
- Optional `HELM_PASSTHROUGH_EXPECTED_OUTPUT` - sentinel the CLI output must contain; default `HELM_LIVE_OK`.
- Optional `HELM_PASSTHROUGH_LIVE_TIMEOUT_MS` - per-CLI timeout, default `120000`.

For deterministic local development only, set `HELM_PASSTHROUGH_LIVE_DRY_RUN=1` to write the report without invoking the CLIs. Do not use dry-run for merge or release acceptance.
