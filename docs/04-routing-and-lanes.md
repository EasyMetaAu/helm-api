# 04 · Routing & Lanes

Once classification ([03](03-classification.md)) has produced `task_type` /
`complexity` / `constraints`, the routing layer selects one lane and then executes
its ordered chain. The framework-agnostic orchestrator is `routeRequest`
(`packages/core/src/routing/route-request.ts`); lane selection is in
`routing/lane-resolver.ts` and policy evaluation in `routing/policy-engine.ts`.

## Lane routing priority

```text
explicit model/lane           # client specified a concrete model; skips all rules
  > server-side policy         # a policy pin (use_lane)
  > task-specific lane         # a lane named after the detected task_type
  > complexity-fallback lane   # simple→economy / medium→balanced / complex→premium
```

Default lanes are deliberately few and easy to reason about. Any selected lane
name that does not exist is skipped (fail-open); the terminal `balanced` is
guaranteed to exist.

### Explicit client model has the highest priority

When a client specifies a concrete model **or a lane name**, classification and
policy are skipped and the request is executed directly (the nginx pass-through
equivalent). Whether this is allowed is controlled by the key's
`allow_custom_model` capability (see
[06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md)). The sentinel
value `auto` is never treated as an explicit model — it means "let the router
decide" and falls through to classification.

For an `allow_custom_model` key the `model` field resolves in this order:

1. **Lane name** (lanes shadow same-named model aliases): the lane's chain is
   expanded and executed with full fallback semantics. The lane must sit inside
   the key's `allowed_lanes` whitelist — an explicit ask for a forbidden lane is
   rejected with `invalid_request` (400), **never silently downgraded** (only
   classified routing clamps via `applyCaps`).
2. **Model alias**: executed as a single-candidate chain (no fallback). The name
   is validated against what the deployment can actually serve (providers.yaml
   registry ∪ live curated OAuth aliases ∪ `provider/`-prefixed aliases whose
   client is registered); an unknown name is rejected with `invalid_request`
   (400) instead of silently falling through to the default provider.
3. Over-budget `degrade` (docs/06) suppresses BOTH forms of explicit passthrough
   — the request is forced onto the degrade lane.

Keys **without** `allow_custom_model` ignore the `model` field entirely (any
value behaves like `auto` and routes via classification); it is recorded in
telemetry as `requested_model` only.

## Lanes

Lanes are defined in [`config/lanes.yaml`](../config/lanes.yaml) and validated by
`LanesConfigSchema` at load time — an invalid file fails the gateway boot
(principle 2). A lane is a declarative chain: a `primary` plus an ordered
`fallback[]`, where each element is either a model **alias** (`provider/model`,
resolved via `config/providers.yaml`) or the name of another lane (expanded
recursively, deduped, cycle-safe). Optional `constraints` drive the Capability
Filter (`require_tools` / `require_json` / `require_vision`).

The shipped quality/cost lanes:

```yaml
economy:
  purpose: Cheap and fast for simple tasks
  primary: deepseek/deepseek-v4-flash
  fallback: [openai-codex/gpt-5.4-mini, balanced]

balanced:
  purpose: Default quality/cost tradeoff (classification fallback terminal)
  primary: deepseek/deepseek-v4-pro
  fallback: [openai-codex/gpt-5.4, zenmux/auto, openrouter/auto]

premium:
  purpose: Strong reasoning and high quality
  primary: openai-codex/gpt-5.5
  fallback: [deepseek/deepseek-v4-pro, zenmux/claude-opus-4.7, zenmux/auto, openrouter/auto]
```

`balanced` is **required** and must be healthy — it is the terminal of the
classification fallback.

The shipped task lanes (the lane resolver maps a classified `task_type` onto a
same-named lane):

```yaml
coding:
  purpose: Coding-capable models for code generation / editing
  primary: openai-codex/gpt-5.5
  fallback: [premium, balanced]

json:
  purpose: Strict structured-output (JSON) responses
  primary: deepseek/deepseek-v4-flash
  fallback: [balanced]
  constraints:
    require_json: true

vision:
  purpose: Multimodal / image understanding
  primary: zenmux/gemini-3.5-flash
  fallback: [premium]
  constraints:
    require_vision: true

tool_use:
  purpose: Reliable function / tool calling
  primary: openai-codex/gpt-5.5
  fallback: [premium]
  constraints:
    require_tools: true
```

If no task-specific lane is configured, the resolver falls back to the three
default lanes by complexity (`simple → economy`, `medium → balanced`, `complex →
premium`).

Note the deliberate design where each lane's tail fallback is a `*/auto` alias
(e.g. `zenmux/auto`, `openrouter/auto`). Those auto aliases are intentionally
JSON-incapable in the catalog, so a strict-JSON request prunes them via the
Capability Filter and lands on a deterministic JSON-capable model — proving the
filter fires on the default config. `*/auto` aliases live only at the tail.

## Policies

Policies (`config/policies.yaml`) let operators customize routing server-side
without touching client code. Each policy is a **first-match** rule: the engine
walks the list top-to-bottom, and the first policy whose `match` fully holds (an
AND of every written field) wins the lane pin. A policy must declare at least one
action — a pin (`use_lane`) and/or a cap (`max_lane` / `allowed_lanes`). The file
is `.strict()`-validated, so a typo in a field name fails the gateway boot.

Caps behave differently from pins: while the **first** matching policy wins the
pin, caps **accumulate** across every matching policy (intersect `allowed_lanes`,
keep the strictest `max_lane`), so a cap policy placed after a pin policy still
binds.

The shipped policies illustrate the pattern (`task_type × complexity → lane`,
plus a JSON-contract pin and a budget-org cap):

```yaml
policies:
  - id: json_constrained_to_json_lane     # JSON is a hard output contract; kept first
    match: { needs_json: true }
    use_lane: json

  - id: coding_complex_to_coding_lane
    match: { task_type: coding, complexity: complex }
    use_lane: coding

  - id: math_complex_to_premium
    match: { task_type: math, complexity: complex }
    use_lane: premium

  - id: chat_simple_to_economy
    match: { task_type: chat, complexity: simple }
    use_lane: economy

  - id: budget_org_cap                     # caps-only; clamps the classified lane
    match: { org_id: budget_org }
    max_lane: balanced
```

Policies must stay explicit and inspectable; there is no hidden, hard-to-debug
model scoring behind them. Note that the policy `complexity` field uses the
collapsed routing tiers (`simple | medium | complex`), matching the classifier's
mapped output (see [03](03-classification.md)).

## Caps: policy then key

Two cap layers apply, in order:

1. **Policy caps** narrow the resolver's lane choice (`max_lane` /
   `allowed_lanes`).
2. **Per-key caps** apply **last** as the outer, non-negotiable bound from the
   API key's auth record, so a key whose `allowed_lanes` whitelist is confined
   to (for example) `[economy]` is honored even over a policy `use_lane` pin. See
   [06](06-auth-and-rate-limits.md).

## Execution model and the two fallbacks

The selected lane is expanded into an ordered candidate chain (primary →
fallback[], with lane references expanded recursively). The executor
(`packages/core/src/executor/fallback.ts`) then walks the chain:

1. Try the primary.
2. Skip a candidate the Capability Filter rejects (with an explicit skip reason).
3. Skip a candidate whose circuit breaker is `OPEN`.
4. On a provider error, timeout, or rate limit before the first valid chunk,
   record the failure on the breaker and try the next candidate.
5. A `:free` alias that returns 429 is skipped without recording a breaker failure
   (free-tier throttling is not a health signal).
6. A client abort terminates the chain as a non-provider fault — it records
   neither a failure nor a success and is **not** counted as
   `all_providers_failed`.
7. If every candidate fails, return a structured `all_providers_failed` error; an
   empty chain returns `lane_unavailable` (see
   [07 · Error Model & Observability](07-observability.md)).
8. Record every attempt with its reason and latency.

This in-chain model swap is the **execution fallback** — it never rewrites the
lane. The **classification fallback** (→ `balanced`) is the separate mechanism
from [03](03-classification.md). Their fields in the decision record are distinct:
classification fallback shows up as `classifier.decided_by` / `fallback_reason`,
while execution fallback shows up as `provider_attempts` / `fallback_count`.
