# 04 · Routing & Lanes

Once classification ([03](03-classification.md)) has produced `task_type` /
`complexity` / `constraints`, the routing layer selects one lane and then executes
its ordered chain. The framework-agnostic orchestrator is `routeRequest`
(`packages/core/src/routing/route-request.ts`); lane selection is in
`routing/lane-resolver.ts` and policy evaluation in `routing/policy-engine.ts`.

## Lane routing priority

```text
model-alias shim               # fixed vendor id → lane / `auto`; cap-bounded; allow_custom_model keys only
  > explicit model/lane        # concrete model/lane; skips classify + policy; allow_custom_model keys only
  > classifier short-circuit   # decided_by 'default' | 'fallback' → straight to the default fallback lane (classified branch only)
  > server-side policy         # a policy pin (use_lane)
  > task-specific lane         # a lane named after the detected task_type
  > complexity-fallback lane   # simple→economy / medium→balanced / complex→premium (NOT affected by default_lane)
  > signal feedback (opt-in)   # promote degraded ranked lanes inside caps
  > default fallback lane      # System Settings `default_lane` (default `balanced`); used only if it exists, else `balanced`
```

The **model-alias compatibility shim** and explicit model/lane passthrough are
both **gated on `allow_custom_model`** (and suppressed while over-budget
degrading). A key **without** `allow_custom_model` skips both — its `model` field
is ignored and **every** request is classified (the `auto` path). For a
custom-model key the shim runs first (priority 0; see
[Model-alias compatibility shim](#model-alias-compatibility-shim) below), then
explicit passthrough — a request naming a concrete model or lane skips
classification and policy entirely and is executed directly.

Within the classified branch, the resolver applies its own priority-0
short-circuit: if the classifier `decided_by` is `default` (classify() itself
threw — hard fail-open) or `fallback` (eval/rules abstained), the request goes
**straight to the default fallback lane** without re-deriving a lane. Both signals
mean "we are not confident enough to steer," so they collapse to the safe terminal.

The terminal fallback lane is operator-configurable via the admin **System
Settings** (`runtime.default_lane`, hot-applied, default `balanced`). It is used at
**both** fail-open terminals — the classifier short-circuit above and the final
"nothing resolved" sink — **but only if the named lane exists**; otherwise the
resolver falls back to the literal `balanced`. It does **not** change the
complexity-fallback tiers (`simple→economy / medium→balanced / complex→premium`),
which keep their fixed targets. An unknown lane is rejected (400) at the settings
write boundary, so a stale value can only arise if a lane is deleted afterwards —
in which case the `balanced` floor takes over.

Default lanes are deliberately few and easy to reason about. Any selected lane
name that does not exist is skipped (fail-open); the terminal `balanced` is
guaranteed to exist.

When `runtime.signal_feedback.enabled` is true, the router performs one
fail-open read of aggregated Agentic Signals after policy/key caps are applied
and before expanding the execution chain. It can only promote a degraded ranked
lane (`economy` or `balanced`) to a stronger ranked lane with healthier aggregate
success/error/fallback rates. It never runs on explicit passthrough,
classifier-default/fallback, policy `use_lane` pins, or over-budget degradation,
and it never escapes policy/key caps.

### Model-alias compatibility shim

For an `allow_custom_model` key, `plan()` runs a **priority-0** model-alias
resolution step (route-request.ts steps 0 / 0a) ahead of explicit passthrough.
Clients that pin a **fixed vendor model id** — Claude Code's `claude-opus-4-8`,
or an SDK locked to `gpt-5.5` — know neither Helm's lanes nor its provider
aliases, so left alone they would get a `400 unknown model`. The shim rewrites
that inbound `model` field onto a lane (or the `auto` sentinel) **before**
routing, so a fixed-model client routes cleanly while Helm still only exposes the
lane abstraction (principle 6 — the literal vendor id is never sent upstream). A
key **without** `allow_custom_model` does not use the shim at all: its `model`
field is ignored and the request is classified like `auto` (still no `400`).

The map is [`config/model-aliases.yaml`](../config/model-aliases.yaml): a flat
table of vendor model id → a lane name or `auto`. Keys are glob-matchable and
**case-sensitive** — an exact key wins, otherwise the matching `*`-glob with the
most literal characters wins (so `claude-opus-*` beats `claude-*` regardless of
order; `*` absorbs any date/suffix). Targets are boot-validated to a configured
lane or `auto` (fail-closed, principle 2); the file is optional — delete it for
no rewrite.

The shim is **operator-authorized** (the operator owns the mapping) but is
**gated on `allow_custom_model`** — honoring a pinned vendor id is a custom-model
capability:

1. It applies **only to `allow_custom_model` keys**. A key **without** that
   capability routes **everything through classification (`auto`)** — its `model`
   field, even a known vendor id, is **ignored** (never a 400) and the alias map
   is not consulted (see "Explicit client model" below — one rule covers explicit
   models, lanes, and alias-mapped ids).
2. It runs **before** explicit-passthrough resolution (so a known vendor id maps
   to a lane instead of 400ing as an unknown model), but it is **cap-bounded**,
   not a bypass. Policy `allowed_lanes` and the key's own `allowed_lanes`
   whitelist both still clamp the resolved lane. The clamp is
   **silent** (the same `applyCaps` path classified routing uses), **not** the
   loud `invalid_request` reject an explicit forbidden-lane ask gets — so even a
   custom-model key can never use an operator alias to escape a cap.
   (Task/complexity-scoped policies do not fire here: an alias request is not
   classified.)
3. It is **suppressed while the key is over-budget/degrading** — the request
   falls through to the forced degrade lane (docs/06), no bypass.
4. An alias that maps **to `auto`** does not passthrough the literal vendor id;
   it falls through to classification, letting the router decide per request.

### Explicit client model

When a client specifies a concrete model **or a lane name**, classification and
policy are skipped and the request is executed directly (the nginx pass-through
equivalent). Whether this is allowed is controlled by the key's
`allow_custom_model` capability (see
[06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md)). The sentinel
value `auto` is **never** treated as an explicit model — it means "let the router
decide" and forces classification.

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

The shipped quality/cost lanes (the three ranked lanes; `LANE_RANK` orders only
these: economy=0 < balanced=1 < premium=2):

```yaml
economy:
  purpose: Cheap and fast for simple tasks
  primary: deepseek/deepseek-v4-flash
  fallback: [openai-codex/gpt-5.4-mini, openrouter/deepseek-v4-flash, balanced]

balanced:
  purpose: Default quality/cost tradeoff (classification fallback terminal)
  primary: deepseek/deepseek-v4-pro
  fallback: [openrouter/deepseek-v4-pro, zenmux/claude-sonnet-4.6, zenmux/auto, openrouter/auto]

premium:
  purpose: Strong reasoning and high quality
  primary: openai-codex/gpt-5.5
  fallback: [zenmux/claude-opus-4.8, zenmux/gpt-5.5, balanced]
```

`balanced` is **required** and must be healthy — it is the terminal of the
classification fallback.

The shipped task lanes (the lane resolver maps a classified `task_type` onto a
same-named lane). These are **unranked** — incomparable to the quality/cost
lanes, so `applyCaps` treats an unrankable task lane conservatively when an
`allowed_lanes` whitelist is in force (degrading it toward `balanced`):

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
quality/cost lanes by complexity (`simple → economy`, `medium → balanced`,
`complex → premium`).

### Vendor-family lanes

Beyond the 7 generic lanes above, `config/lanes.yaml` ships **9 vendor-family
lanes** — the rewrite targets of the [model-alias compatibility
shim](#model-alias-compatibility-shim):

```text
claude-opus   claude-fable   claude-sonnet   claude-haiku
gpt-5.5       gpt-5.4        gpt-5.4-mini
gemini-pro    gemini-flash
```

(16 lanes total.) These exist so a client that pins a fixed vendor id lands on
that family's real model instead of the GPT-led `premium` lane. Each one
**leads with the requested vendor's native/subscription alias** — the Claude
lanes with the `anthropic/*` Claude OAuth pool, the GPT lanes with the
`openai-codex/*` subscription, the Gemini lanes with the static `zenmux/*` key —
then **degrades into a generic quality lane** (e.g. `claude-opus → premium`,
`gpt-5.4-mini → economy`). An unconnected subscription alias **fails OPEN** (skip
to the next fallback), never a 5xx, so an unbound subscription just serves the
request from the generic-lane backing.

### Provider mix and the `*/auto` tail

The cheap and default lanes anchor on the **always-available** official
`deepseek` primary — a static key that works in dev, e2e, and a fresh install
with no subscription bound. The `premium` / `coding` / `tool_use` lanes lead with
the `openai-codex` subscription channel (connect it in admin → Providers), each
backed by a static fallback so the lane **degrades gracefully**: an unconnected
`openai-codex/*` candidate fails OPEN (skip to the next fallback), never a 5xx.

The `*/auto` aliases (`zenmux/auto`, `openrouter/auto`) sit only at the **tail of
the `balanced` chain** — every other lane reaches them by falling through to
`balanced`, not by carrying its own auto tail. Those auto aliases are
deliberately JSON-incapable in the catalog (`supportsJsonMode: false`), so a
strict-JSON request prunes them via the Capability Filter and lands on a
deterministic JSON-capable model — proving the filter fires on the default
config.

### Chain expansion

`expandLaneChain` flattens `primary` + `fallback[]` into one ordered candidate
list, expanding nested lane references recursively. Dedup keeps the **first**
occurrence of each candidate; a visited-set cycle guard makes self/mutual
references safe. Expansion is pure: it trips no circuit breakers and applies no
capability filter — those happen later, in the executor.

## Policies

Policies (`config/policies.yaml`) let operators customize routing server-side
without touching client code. Each policy is a **first-match** rule: the engine
walks the list top-to-bottom, and the first policy whose `match` fully holds (an
AND of every written field) wins the lane pin. A policy must declare at least one
action — a pin (`use_lane`) and/or a restrict (`allowed_lanes` whitelist). The file
is `.strict()`-validated, so a typo in a field name fails the gateway boot.

Caps behave differently from pins: while the **first** matching policy wins the
pin, the `allowed_lanes` whitelist **accumulates** (intersection) across every
matching policy, so a restrict policy placed after a pin policy still binds.

The nine shipped policies, in evaluation order (`task_type × complexity → lane`,
plus a JSON-contract pin first and a budget-org cap last):

```yaml
policies:
  - id: json_constrained_to_json_lane     # JSON is a hard output contract; kept first
    match: { needs_json: true }
    use_lane: json

  - id: coding_complex_to_coding_lane
    match: { task_type: coding, complexity: complex }
    use_lane: coding

  - id: coding_simple_to_economy          # trivial code must not hit a coding-grade model
    match: { task_type: coding, complexity: simple }
    use_lane: economy

  - id: math_simple_to_balanced           # math is never economy
    match: { task_type: math, complexity: simple }
    use_lane: balanced

  - id: math_complex_to_premium
    match: { task_type: math, complexity: complex }
    use_lane: premium

  - id: chat_simple_to_economy
    match: { task_type: chat, complexity: simple }
    use_lane: economy

  - id: chat_complex_to_premium
    match: { task_type: chat, complexity: complex }
    use_lane: premium

  - id: security_complex_to_premium       # only complex security is pinned
    match: { task_type: security, complexity: complex }
    use_lane: premium

  - id: global_economy_cap                 # restrict-only catch-all; clamps ALL traffic
    match: {}                              # empty match = applies to every request
    allowed_lanes: [economy, balanced]     # premium becomes unreachable fleet-wide
```

Policies must stay explicit and inspectable; there is no hidden, hard-to-debug
model scoring behind them. Note that the policy `complexity` field uses the
collapsed routing tiers (`simple | medium | complex`), matching the classifier's
mapped output (see [03](03-classification.md)).

## Caps: policy then key

Two cap layers apply, in order:

1. **Policy `allowed_lanes`** narrow the resolver's lane choice to a whitelist.
   An unranked task lane (not in `LANE_RANK`) is treated conservatively —
   degraded toward `balanced`, never escalated to the strongest allowed lane.
2. **Per-key caps** apply **last** as the outer, non-negotiable bound from the
   API key's auth record, so a key whose `allowed_lanes` whitelist is confined
   to (for example) `[economy]` is honored even over a policy `use_lane` pin. See
   [06](06-auth-and-rate-limits.md).

## Execution model and the two fallbacks

The selected lane is expanded into an ordered candidate chain (primary →
fallback[], with lane references expanded recursively). The executor
(`packages/core/src/executor/fallback.ts`) then walks the chain, recording every
attempt with its reason and latency:

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

`fallback_count` counts only **non-skipped** attempts beyond the first (i.e.
candidates actually attempted upstream, whether they succeeded or failed) —
candidates pruned by the Capability Filter or skipped for an OPEN breaker do not
increment it.

This in-chain model swap is the **execution fallback** — it never rewrites the
lane. The **classification fallback** (→ `balanced`) is the separate mechanism
from [03](03-classification.md). Their fields in the decision record are distinct:
classification fallback shows up as `classifier.decided_by` / `fallback_reason`,
while execution fallback shows up as `provider_attempts` / `fallback_count`.
