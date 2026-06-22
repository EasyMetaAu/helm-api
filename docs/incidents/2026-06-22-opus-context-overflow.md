# 2026-06-22 Opus Context Overflow Incident

All times below are UTC. Evidence came from production SQLite on `la.atmy.work`
using `/opt/helm-api/data/helm.db` in read-only mode. No captured prompt text is
included here.

## Trigger Requests

- `ec1dcf69-0493-4729-b160-4bf1a7d8fca0` at `2026-06-22 01:27:59`
- `2d698330-d6d5-4b82-979e-a0fc60417e64` at `2026-06-22 01:28:23`

The user-facing failure burst ran from `2026-06-22 01:28:23` to
`2026-06-22 01:33:50` and contained 10 failed requests after the first trace.

## Confirmed Root Cause

The failing native Anthropic request targeted `claude-opus-4-8` and Anthropic
returned:

```text
prompt is too long: 1001854 tokens > 1000000 maximum
```

The failing request had:

- `request_len`: about 3.21 MB
- `messages`: 864
- `tools`: about 127 KB
- `system`: about 7 KB
- `thinking.type`: `adaptive`
- `output_config.effort`: `xhigh`
- `context_management`: `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`

A later request, `f5221b67-8323-4eb5-a71e-7d2448e06b6c` at
`2026-06-22 01:40:11`, succeeded on the same model with the same tools/system,
same `thinking`, same `output_config`, and same `context_management`, but with
841 messages and `prompt_tokens=924300`.

This means the burst was sent before enough client-side history cleanup or
compaction had reduced the active prompt below the hard 1M-token limit. Helm's
own memory middleware was not active for these traces: `decision_json.memory`
was empty.

## Secondary Problems Exposed

1. Mid-stream failures can be recorded as `ok`.
   `ec1dcf69-0493-4729-b160-4bf1a7d8fca0` is stored with `final_status=ok`, but
   its captured response contains only `message_start` followed by an Anthropic
   `event: error` with `upstream error`. Docker also logged
   `stream.truncated` for `openai-codex/gpt-5.5`.

2. `response.failed` details from the Codex Responses stream are too lossy.
   Eight fallback attempts to `openai-codex/gpt-5.5` only stored the generic
   message `codex responses stream error`, with no provider raw event body.

3. Request-shape 400s pollute provider health.
   The executor records `prompt too long` and unsupported effort 400s as provider
   failures, so repeated retries opened circuits and produced a later request
   where candidates were skipped as `circuit_open`.

4. Cross-model fallback forwards incompatible Anthropic effort.
   Fallback to `anthropic/claude-sonnet-4-6` returned:

   ```text
   This model does not support effort level 'xhigh'. Supported levels: high, low, max, medium.
   ```

   Helm forwarded the client `output_config.effort=xhigh` to Sonnet instead of
   applying a model-aware clamp or skip.

5. `upstream_request_json` is null on all-failed requests.
   The payload table only captures the served attempt's upstream body. For an
   all-failed chain, the exact upstream body for failed attempts is not persisted,
   which makes later diagnosis harder.

6. Balance-only failures are present but not primary for this incident.
   `zenmux/*` attempts returned 402 insufficient credit. Per user instruction,
   these should be ignored for root-cause prioritization.

## Fixes Applied

- Added an Anthropic native `count_tokens` preflight in the executor. Known Claude
  4.x native models use the conservative 1,000,000-token hard ceiling, combined
  with catalog limits by taking the smaller value. Over-limit candidates are
  skipped with `context_too_small` and do not trip the circuit breaker.
- Added a model-aware guard for `claude-sonnet-4-6` so unsupported
  `output_config.effort` values such as `xhigh` skip the candidate with
  `unsupported_reasoning_effort` instead of burning an upstream 400.
- Classified Anthropic request-shape 400s such as `prompt is too long` and
  unsupported effort as `invalid_request` attempt errors that do not count
  against provider health.
- Fixed `/v1/messages` stream telemetry so a stream that emits a terminal
  `event: error` is persisted with `final.status=error`.
- Preserved Codex Responses `response.failed` / `error` SSE events in
  `UpstreamError.providerRaw`, so attempt `error_detail.provider_raw` can explain
  what the backend actually sent.

## Recommended Fix Order

1. Done: add a deterministic preflight for native Anthropic requests near context
   limits. Use Anthropic token counting when the request is large or the selected
   lane/model has a hard context ceiling. Skip an over-limit candidate with
   `context_too_small` before burning the upstream attempt.

2. Done: treat upstream 400 request-shape errors as non-provider-health failures.
   `prompt too long` and unsupported effort should not open the circuit breaker.

3. Done: make Anthropic `output_config.effort` model-aware.
   For Sonnet, clamp `xhigh` to a supported level or skip the candidate with a
   structured reason such as `unsupported_reasoning_effort`.

4. Done: fix stream telemetry. If a stream throws after the first frame and the route
   emits an error frame, record the final request as a stream error, not `ok`.

5. Done: preserve Codex stream failure detail safely.
   When `response.failed` or `error` arrives without a simple message, store a
   scrubbed provider raw event in `error_detail.provider_raw`.

6. Pending: improve failed-attempt payload observability.
   Capture at least the last attempted upstream body for all-failed chains, or add
   per-attempt upstream body capture under the existing `capture_payloads` setting.
