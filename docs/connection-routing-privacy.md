# Connection checks, account evidence and optional privacy

This change adds six small improvements inspired by the Magpie study. Helm keeps
its headless gateway and lane interface. Defaults remain unchanged.

## Verify a client connection

The Portal **Connect** page offers **Test inference** for Claude Code, Codex and
OpenAI SDK clients. Choose a lane (or `auto`), then start the test explicitly.
It first checks authenticated model discovery, then sends one short streamed
request through the normal Messages, Responses or Chat route. Normal key
permissions, quotas and routing still apply. The upstream may charge for it.

Authentication and inference have separate results. Inference succeeds only
after visible output and a successful terminal event, with no later error.
Empty streams, partial streams, failed/incomplete Responses events, timeouts and
non-2xx responses are not success. The test has a 30-second timeout and a
256-KiB response limit. Cancel stops the request. It does not claim to test every
tool or modality, and a browser fixture is not production acceptance.

## Explain an account choice

The administrator's request detail shows **Why this account?** for subscription
pool requests. The stored selection snapshot includes the strategy, reason,
selection time, candidate exclusions, quota freshness/pressure, expiry score,
next reset and available speed observations. At most 20 candidates are retained,
including the selected account; the omitted count is explicit. Unknown data is
`null`, not zero. This is a selection-time snapshot, not a later reconstruction.

It is stored as optional metadata in `serving_account.selection`; old records
remain readable. The Portal's whitelist does not expose candidates or accounts.
No new table or migration is needed.

## Optional speed-first subscription selection

Select **Speed first** in the administrator's subscription account strategy
control. It ranks eligible accounts for the same provider/model and priority.
It never changes lanes, provider capabilities, credential status, quota limits,
capacity checks or strong continuation bindings. Static API key pools retain
their existing configured strategies.

The score estimates a 200-token response using first-output time plus observed
output tokens per second. Missing throughput uses the pool's median when one is
available. Observations decay with a 20-minute half-life and expire after an
hour; memory is bounded to 1,024 account/model observations per pool. A 10%
similarity band retains a sticky account. Normal requests occasionally give an
unmeasured account a turn; there are no background probes or extra model calls.
Restarting the gateway discards these passive observations.

After a real upstream failure interrupts an already-started stream, that stream
still fails and is never replayed. A brief account cooldown lets a subsequent
independent request choose a healthy sibling. Client cancellation does not cool
the account; strong stateful continuations cannot silently switch accounts.

## Experimental text privacy, off by default

Configure `runtime.outbound_privacy` in `config/runtime.yaml`, or set
`HELM_OUTBOUND_PRIVACY` to `off`, `mask` or `block`. Invalid values reject startup.

- `off`: existing request and response behavior.
- `mask`: replace detected token-shaped secrets before text inference and
  restore them in the caller's ordinary response text/tool argument values.
- `block`: reject requests containing those values instead of forwarding them.

The first version recognizes `sk-…`, GitHub token forms and AWS `AKIA…` access
key IDs. It is **not** a general password, PII, binary-content or encoded-secret
detector. A value outside these patterns may be sent unchanged.

The supported HTTP surface is self-contained text Chat, Messages, Responses and
Gemini generation, with their supported token-count helpers. Bodies are bounded
to 1 MiB. The request is masked before entering the route, and checked again
after memory injection but before classification/eval and provider execution.
Original native body bytes are masked along with normalized content. Capture
and new session history see placeholders rather than the original detected
values. The response is restored only at the client HTTP boundary.

Restoration maps live only in that request's memory. Each request uses a random
namespace, so one key/request cannot resolve another request's placeholders.
No mapping is saved in telemetry, payloads, caches or recovery files. Repeated
values are stable within one request; **they are not stable across requests**,
which can reduce prompt-cache reuse. Previously captured masked payloads cannot
be restored after the request ends.

When enabled, unsupported media APIs (including TTS and 3D), response lifecycle
and compact operations, WebSocket/stateful continuations, opaque/signed input
blocks, uploaded files and media content are rejected. Admin provider test and
replay operations that bypass the normal text boundary are also rejected. This
is deliberately a limited HTTP text feature, not whole-process outbound DLP:
existing stored data and independent background memory/embedding jobs are not
retroactively protected. Do not enable it for a workload that requires these
unsupported operations. It does not scan local credentials or the Keychain.

Stream restoration handles network fragmentation and independent text/tool
delta channels. Signed/encrypted output is left untouched. Malformed streams
and incomplete placeholders fail rather than claiming success. Downstream
cancellation cancels the upstream reader before waiting for generator cleanup.

## A reversible local connection helper

From a source checkout with dependencies installed:

```sh
pnpm client:connect preview --client codex --url https://helm.example --model auto --plan /tmp/helm-connect-plan.json
pnpm client:connect apply --plan /tmp/helm-connect-plan.json
# Set HELM_API_KEY in your shell, then:
codex --profile helm
pnpm client:connect rollback --receipt ~/.config/helm-client/codex.receipt.json
```

Use `--client claude` for Claude Code, then run `claude`. Claude uses
`apiKeyHelper = "printenv HELM_API_KEY"`; Codex uses `env_key = "HELM_API_KEY"`.
The helper neither reads credential stores nor saves the API key. Existing Claude
authentication settings are a conflict, not silently replaced. It respects
`CODEX_HOME` and `CLAUDE_CONFIG_DIR`; the profile name is `helm` and the lane can
be any configured name. Remote endpoints require HTTPS; loopback HTTP is allowed.

Preview writes only a private plan, never the client config. Config, plan and
receipt paths must be distinct. Apply rechecks the original file hash, then
writes atomically with a private recovery receipt. Codex gets an appended owned
provider/profile block, leaving existing defaults and unrelated bytes intact.
Claude edits only its three owned fields, preserving JSON comments. Rollback
preserves later unrelated user changes and refuses to overwrite changed owned
fields/blocks. An existing unmanaged `helm` profile/provider is a conflict.

Interrupted apply keeps its prepared receipt: an unchanged original file can be
cleared through rollback, an exact applied file is recognized on retry, and any
other state is left for inspection. Do not delete recovery receipts until the
intended result is confirmed. Config symlinks are currently unsupported.

## Validation and release boundary

Focused checks cover connection success/failure, privacy isolation and wire
fragmentation, cancellation, native body masking, late-stream recovery, passive
speed selection, candidate visibility and configuration rollback. The browser
flow uses synthetic HTTP fixtures and no paid calls:

```sh
CI=true pnpm --filter @helm/gateway exec playwright test --config playwright.portal.config.ts e2e/portal-connect.spec.ts
```

Release assessment: a release is appropriate after the feature PR passes required
CI and is merged. Keep privacy off and the existing account strategy as defaults;
enable the optional modes only for their documented workloads. Prepare the next
available version with `pnpm release:prepare <version>`, commit its official client
snapshots, then verify that exact release through the normal pipeline. Feature
tests or a PR are not evidence of live provider compatibility or deployment.

Source reference: Magpie `c30d3b7b63e818d3b7d9c3eb6fcdada4c7d8c5e0`
inspired the behavior/checklist; no Go implementation was copied or translated.
