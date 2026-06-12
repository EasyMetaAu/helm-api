# 03 · Classification Cascade

## The classification cascade

This is Helm's core. When a request arrives, the cascade decides a lane in three
ordered layers, stopping at the first one that commits (hit-stop):

```text
Request in
  → Layer 1: deterministic rules            [always on; zero cost, zero latency]
        confidence ≥ threshold → go straight to the resolved lane
  → Layer 2: small-model eval               [OFF by default; cached]
        the small model decides complexity / task_type → resolved lane
  → Layer 3: fallback → balanced lane       ← always-safe default
```

The cascade itself is framework-agnostic
(`packages/core/src/classifier/cascade.ts`), driven by the live, Zod-validated
configuration in `config/classifier.yaml`. With eval off by default
(`eval.enabled: false`), the cascade degrades to the two-layer "rules + balanced"
path — Layer 2 is a pure additive switch. A **confident Layer 1 ends the cascade
even when eval is enabled** — high confidence never spends an eval call.

**Key distinction: the two fallbacks are different things and are recorded
separately.**

- **Classification fallback**: "I cannot tell what this task is" → fall to the
  `balanced` lane. Recorded as `decided_by: fallback` (with a precise
  `fallback_reason`).
- **Execution fallback** (provider fallback): "the selected provider failed /
  timed out / was rate-limited" → try the next model in the lane chain. Recorded
  under `provider_attempts` / `fallback_count`.

The first happens while *choosing* a lane; the second happens while *executing*
one. Two mechanisms, two sets of log fields — never conflated (principle 5).
Execution fallback is covered in [04 · Routing & Lanes](04-routing-and-lanes.md).

### `decided_by`: who chose the lane

The classifier itself emits `rules` | `eval` | `fallback`. There is a fourth
value, `default`, written one layer up: if `classify()` *throws* outright, the
routing orchestrator hard fail-opens (principle 3) — it degrades to `balanced`
and stamps `decided_by: default` rather than surfacing a 5xx
(`packages/core/src/routing/route-request.ts`).

So when you debug a `balanced` decision:

- `decided_by: fallback` → the cascade ran to Layer 3 (uncertain, no commit).
- `decided_by: default` → the classifier *errored* and we caught it.

Both route straight to `balanced` without re-deriving a lane from
task/complexity (`lane-resolver.ts`), but they mean different things — one is
"couldn't decide", the other is "blew up".

## Classifier output

The classifier produces:

```yaml
complexity: simple | standard | complex | reasoning
task_type: chat | coding | math | writing | extraction | tool_use | vision | web | data | security
confidence: number          # [0,1); below the threshold cascades to the next layer
constraints:
  needs_tools: boolean
  needs_json: boolean
  needs_vision: boolean
  long_context: boolean
  low_latency: boolean
  low_cost: boolean
```

> The classifier emits four complexity tiers (`simple | standard | complex |
> reasoning`). For lane routing these collapse to three: `standard → medium`,
> and both `complex` and `reasoning → complex` (see
> `apps/gateway/src/routes/classify.ts`). The `reasoning` tier is parked high in
> the score distribution to keep the high-score cluster away from any boundary; it
> does not change lane routing.

The classifier's inputs are the last user message and recent messages, the tool
definitions, the response format, the max-token target, and attachment / vision
metadata.

## Layer 1: deterministic rules

Layer 1 is a local, deterministic, zero-cost weighted scorer
(`packages/core/src/classifier/`, the `dimensions` → `momentum` → `tiers` →
`overrides` → `taskdetect` pipeline composed by `engine.ts`). It is a pure
function fed by the already-parsed config (principle 4), and every sub-step is
wrapped so a degenerate input yields a safe default instead of throwing
(fail-open).

- **Weighted dimension scoring** (`dimensions.ts`): a set of keyword,
  structural, and context dimensions, each with a weight (the sign is the
  direction) and a `[0,1]` signal strength. Their contributions sum to a
  `rawScore`. Keyword dimensions and their weights are data in
  `classifier.yaml`; structural-signal detectors (code block, URL, stack trace,
  file path, math notation, table, JSON response format, etc.) are code.
- **Four complexity tiers** (`tiers.ts`): fixed half-open boundaries map the
  `rawScore` onto `simple | standard | complex | reasoning`.
- **Task detection** (`taskdetect.ts`): three independent evidence paths fuse —
  keyword sets (data), tool-name prefixes (data, e.g. `browser_` / `code_` /
  `sql_`), and structural signals (code). The highest score that clears its
  activation threshold wins; otherwise the task is `chat`. Some tasks have a
  raised activation threshold (e.g. `web` and `security`) so a single weak signal
  cannot false-trigger them.
- **Session momentum** (`momentum.ts`): **on by default** (`momentum.enabled:
  true`, `ttl_sec: 1800`, `history_size: 5`, `max_history_weight: 0.6`). A short
  follow-up message is weighted by the session's recent classification history
  (keyed by `metadata.conversation_id`, which maps from the `x-session-key`
  header) so one short message does not drag classification off course. It is
  best-effort soft state held only as `complexity` / `rawScore` / timestamp —
  never message content.
- **Hard overrides and shortcuts** (`overrides.ts`): heartbeat tokens (e.g.
  `HEARTBEAT_OK`) snap to `simple`; formal-logic markers snap to `reasoning`; a
  request carrying tools has a floor of `standard`; a very long context
  (`long_context_token_threshold`) raises the floor to `complex`.
- **Confidence gate** (`tiers.ts`): confidence is computed as
  `2·sigmoid(k·distance-to-nearest-boundary) − 1`, normalized to `[0,1)` — a
  score hugging a boundary (distance → 0) is ≈ 0 (most uncertain), a score far
  from any boundary approaches 1 (most certain). When confidence is below
  `rules.confidence_threshold`, Layer 1 is treated as uncertain and the cascade
  enters Layer 2 (if eval is enabled), otherwise Layer 3.
- **Language-coverage guard** (`engine.ts` + `signals.ts`): the keyword lists are
  an English + small high-confidence CJK fast path. Non-covered languages, and CJK
  prompts that miss those lists, are forced `uncertain` (confidence 0) when no
  content-type structural grip exists, so the cascade escalates to multilingual
  Layer-2 eval. **Operator contract**: to serve broad non-English traffic, enable
  eval — with eval **off**, uncovered non-Latin prompts degrade deterministically
  to `balanced` (fail-open) rather than being routed by a keyword score that
  matched nothing. (Latin-script non-English already yields ~0 keyword signal →
  low confidence → eval anyway.) The guard is suppressed for trivially-short
  prompts (already pinned `simple`).

### Tunables live in config

Dimension names, weights, keyword lists, tier boundaries, the sigmoid slope `k`,
and the confidence threshold are all **data** in
[`config/classifier.yaml`](../config/classifier.yaml) — adjust them without
touching code (principle 2). The shipped values are calibrated against a golden
prompt set; rather than reproduce numbers that drift, read the live file. The
salient defaults are `confidence_threshold: 0.42`, `sigmoid_k: 12`, and tier
boundaries `{ standard: -0.06, complex: 0.30, reasoning: 0.85 }`. Treat
`classifier.yaml` as the source of truth.

## Layer 2: small-model eval

When Layer 1 is uncertain (and `eval.enabled` is true), a cheap small model
evaluates the content once, and its verdict decides the lane. It is **off by
default**. The relevant block of `config/classifier.yaml`:

```yaml
classifier:
  rules:
    enabled: true
    confidence_threshold: 0.42     # below this, the cascade may enter eval

  eval:
    enabled: false                 # OFF by default (non-negotiable); needs a configured eval model
    model: deepseek-v4-flash       # a real bare id the primary (official DeepSeek) accepts; sent directly to it
    temperature: 0
    max_tokens: 256                # one JSON object; caps the cost
    extra_body:                    # merged VERBATIM onto the eval wire request (provider-specific knobs)
      thinking: { type: disabled } # stop a reasoning eval model from burning max_tokens on a discarded CoT
    timeout_ms: 1500               # inner runner timeout — covers a real ~1s round-trip with margin
    outer_timeout_ms: 2000         # outer backstop (strictly later than the inner)
    on_failure: balanced           # timeout / parse failure → balanced
    cache:
      enabled: true
      key: content_hash            # canonical(last user message + tools signature, …)
      ttl_sec: 300
      max_entries: 5000            # LRU capacity
```

`extra_body` is a config-driven escape hatch for provider knobs Helm does not
model as first-class; it is merged onto the eval request **before** the locked
fields, so `model` / `temperature` / `stream` / `max_tokens` always win over
anything `extra_body` sets. The `thinking: { type: disabled }` above matters: an
eval model that emits a chain-of-thought (e.g. `deepseek-v4-flash`) spends the
256-token budget on reasoning the classifier discards, truncating the JSON
verdict (`eval_not_json`) and adding ~2s of latency — which forces a too-tight
`timeout_ms` to expire on every cache-miss. Disable reasoning and the call is a
fast, clean ~1s probe, so the tight timeout is safe rather than self-defeating.

The verdict is **decisive**: unlike a pure advisory probe, the eval output
directly selects a lane (a JSON validation failure fails open to `balanced`).
The cache key is a **content hash** (not a `conversation_id`), since the gateway
is stateless — identical or near-identical requests hit the cache and skip a
repeat eval. The cache is held per process and is rebuilt whenever the live
classifier config changes, so a stale verdict computed under old config is never
served.

The eval call goes through the primary provider as an internal small-model call
(the eval model id is sent directly on the wire); it is not one of the
user-facing lanes. Its own token usage is converted to a separate `eval_usd`
cost, kept distinct from completion cost (see
[07 · Error Model & Observability](07-observability.md)).

Whenever the cascade falls to `balanced`, the decision record distinguishes why:
`eval_disabled` (uncertain but eval is off, so no Layer 2 ran) versus
`eval_<timeout|provider_error|circuit_open|not_json|schema_invalid>` (eval ran but
failed open).
