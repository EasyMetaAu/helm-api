# 2026-06-22 Opus Context Overflow Incident

> Historical production incident report. Times, trace ids, row counts, and
> production database observations below are a UTC snapshot from 2026-06-22;
> they were not re-queried during the 2026-07-16 documentation refresh.
> The “Current source status” section was re-audited against repository commit
> `bcd6130` and separates today's behavior from the original fix wording.
>
> Evidence came from production SQLite on `la.atmy.work` using
> `/opt/helm-api/data/helm.db` in read-only mode. No captured prompt text or
> credentials are included.

## Trigger requests (historical)

- `ec1dcf69-0493-4729-b160-4bf1a7d8fca0` at `2026-06-22 01:27:59`
- `2d698330-d6d5-4b82-979e-a0fc60417e64` at `2026-06-22 01:28:23`

The user-facing failure burst ran from `2026-06-22 01:28:23` through
`2026-06-22 01:33:50` and contained ten failed requests after the first trace.

## Confirmed historical root cause

The failing native Anthropic request targeted `claude-opus-4-8`. Anthropic
returned:

```text
prompt is too long: 1001854 tokens > 1000000 maximum
```

The request shape recorded at the time was approximately:

```text
request body: 3.21 MB
messages: 864
tools: 127 KB
system: 7 KB
thinking.type: adaptive
output_config.effort: xhigh
context_management.edits[0]: clear_thinking_20251015, keep=all
```

A later request, `f5221b67-8323-4eb5-a71e-7d2448e06b6c` at
`2026-06-22 01:40:11`, succeeded on the same model with the same tools/system,
thinking, effort, and context-management settings, but 841 messages and
`prompt_tokens=924300`.

The evidence supports one primary cause: the failure burst was sent before
client-side history cleanup/compaction reduced the active native prompt below
Anthropic's one-million-token limit.

Helm memory was not involved in these dated traces. Their
`decision_json.memory` value was empty, so there is no evidence that memory
injection added to or compacted the prompt. The current memory middleware also
does not compact a client's live conversation; it appends long-term recall only.

## Secondary problems exposed in the historical snapshot

1. **A terminal stream failure could be recorded as success.**
   `ec1dcf69-0493-4729-b160-4bf1a7d8fca0` had `final_status=ok`, while the
   captured response contained `message_start` followed by Anthropic
   `event:error`. A related Codex attempt logged `stream.truncated`.

2. **Codex `response.failed` detail was lossy.** Eight fallback attempts stored
   only `codex responses stream error`, without the provider's structured event.

3. **Client/request-shape 400s affected provider health.** Prompt length and
   unsupported effort failures counted like provider faults, opening circuits
   after repeated retries.

4. **Cross-model fallback forwarded incompatible effort.** Sonnet 4.6 rejected
   Anthropic `output_config.effort=xhigh`; the gateway had neither normalized
   the level nor skipped that candidate before sending it.

5. **All-failed payload capture lacked an upstream body.**
   `request_payloads.upstream_request_json` represented only the served attempt.
   With no served attempt, it was null, preventing exact reconstruction of failed
   upstream bodies.

6. **Balance failures were present but not causal.** `zenmux/*` returned 402
   insufficient credit. Per the original incident scope, they were excluded from
   root-cause prioritization.

## Original remediation intent

The June remediation set aimed to:

- count native Anthropic input tokens before an expensive near-limit attempt;
- treat context/request-shape rejection as client/capability behavior rather
  than provider health;
- make reasoning effort model-aware;
- mark terminal stream errors as errors;
- retain structured Codex Responses failure detail;
- improve failed-attempt payload evidence later.

Some implementation details have evolved since that first fix. The current
contracts are below.

## Current source status (2026-07-16)

### 1. Exact native Anthropic preflight exists

`apps/gateway/src/routes/execute.ts` performs provider-backed `countTokens` when:

- the target protocol is native Anthropic Messages;
- a native request is available;
- the provider exposes `countTokens`;
- an effective context limit is known.

The effective limit is the smaller of catalog context and the current hard
limit for known Claude 4.8/4.6/4.5 native models. Visual context compression,
when configured, runs before this preflight so compressed image payloads are
counted rather than the larger original body.

When exact input exceeds the limit, the candidate is recorded as
`context_too_small`, is not attempted, and does not fault the circuit breaker.
If count preflight itself fails, Helm logs
`anthropic.count_tokens_preflight_failed` and fail-opens to the normal attempt.

### 2. Context overflow is candidate-specific

Both preflight overflow and upstream `context_length_exceeded` / “prompt is too
long” responses are capability skips. A later larger-window candidate may still
serve. If the chain ends with only context/capability rejections, the terminal
error is `invalid_request` (HTTP 400) with a compaction-compatible prompt-length
message, rather than a breaker fault.

### 3. Request-shape rejection is terminal but not provider health

Typed 400/413/422 request-shape failures are returned as structured
`invalid_request` without advancing a futile chain or recording a breaker
failure. Context-window and reasoning-history incompatibilities are classified
separately because another candidate may handle them.

### 4. Reasoning effort is capability-driven

The current implementation is not a hardcoded “skip Sonnet on xhigh” rule.
Model capabilities describe supported effort levels and optional mappings.
Checked-in `config/capabilities.yaml` currently maps Anthropic
`claude-sonnet-4-6` output-config `xhigh -> max`; request mutation telemetry
records the model-specific mapping. Other unsupported values can be stripped,
mapped, or rejected according to the target protocol's configured policy.

### 5. Streaming failures retain more truth

The executor guards pre-output stream failures so a provider that emits only a
preamble then `response.failed`/error can fall through before committing
success. Protocol routes also persist terminal error state for in-band failures.
Codex Responses `response.failed`/`error` details can be carried in redacted
`UpstreamError.providerRaw` and then
`provider_attempts[].error_detail.provider_raw`.

The relevant current tests cover terminal Anthropic stream error frames,
Responses `response.failed`, pre-output failover, and provider-raw error detail.

### 6. Failed-attempt upstream payload capture remains incomplete

`ExecuteOutcome.upstreamRequest` still represents the body captured for the
served/returned attempt. Each candidate's local `capturedUpstream` value is not
persisted into `provider_attempts`, and the chain-exhausted outcome has no last
failed body. Therefore `request_payloads.upstream_request_json` can still be null
on all-failed chains.

This is a current observability gap, not a resolved item. A future change should
either:

- capture a redaction-safe per-attempt upstream body/reference; or
- persist at least the last attempted body under the existing
  `capture_payloads` control.

That change must account for payload size, secret redaction, retention, and the
fact that native requests can contain large images/documents.

## Operational lessons

- An HTTP/stream preamble is not success; commit provider success only after
  meaningful output or a terminal success event.
- Context length is a model capability mismatch, not evidence that a provider is
  unhealthy.
- Exact count is most valuable on native near-limit requests; preflight itself
  must remain fail-open.
- Reasoning effort belongs to per-model capability policy, not one global enum.
- `decision_json.memory` being empty is strong evidence that memory middleware
  did not alter a historical request.
- Payload capture designed around a served attempt is insufficient for an
  all-failed fallback chain.

## Verification map

- context preflight/classification/reasoning policy:
  `apps/gateway/src/routes/execute.test.ts`
- Anthropic count route and error envelopes:
  `apps/gateway/src/routes/messages.test.ts` and `messages.errors.test.ts`
- Responses terminal stream status:
  `apps/gateway/src/routes/responses.test.ts`
- provider-raw schema:
  `packages/shared/src/error/schema.test.ts` and
  `packages/shared/src/decision/schema.test.ts`
- upstream payload capture:
  `apps/gateway/src/routes/payload-capture.test.ts` and protocol route tests.
