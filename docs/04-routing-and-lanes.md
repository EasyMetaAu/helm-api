# 04 · Routing & Lanes

Once classification ([03](03-classification.md)) has produced `task_type` /
`complexity` / `constraints`, the routing layer selects one lane and then executes
its ordered chain. The framework-agnostic orchestrator is `routeRequest`
(`packages/core/src/routing/route-request.ts`); lane selection is in
`routing/lane-resolver.ts` and policy evaluation in `routing/policy-engine.ts`.

## Lane routing priority

```text
blocked direct model           # per-key hard reject; lane names are not model patterns
  > image-output model         # exact candidate (telemetry lane `image`), any key; suppressed while over-budget degrading
  > exact lane name            # configured lane; full fallback chain; allow_custom_model keys only
  > exact known model          # deployment-known model; single candidate; allow_custom_model keys only
  > exact model-alias entry    # fixed vendor id → lane / `auto`; cap-bounded; allow_custom_model keys only
  > model-alias wildcard       # most-specific matching glob; last-resort compatibility rewrite
  > classifier short-circuit   # decided_by 'default' | 'fallback' → straight to the default fallback lane (classified branch only)
  > server-side policy         # a policy pin (use_lane)
  > task-specific lane         # a lane named after the detected task_type
  > complexity-fallback lane   # simple→economy / medium→balanced / complex→premium (NOT affected by default_lane)
  > default fallback lane      # System Settings `default_lane` (default `balanced`); used only if it exists, else `balanced`
  > signal feedback (opt-in)   # post-selection promotion of degraded ranked lanes inside caps
```

The **model-alias compatibility shim** and explicit model/lane passthrough are
both **gated on `allow_custom_model`** (and suppressed while over-budget
degrading). A key **without** `allow_custom_model` skips both — its `model` field
is ignored and **every** request is classified (the `auto` path). For a
custom-model key, an exact configured lane or deployment-known model is
authoritative and skips classification/policy. Only otherwise does the shim try
an exact map entry and then the most-specific wildcard. This prevents a broad
rule such as `claude-*` from capturing the exact `claude-opus` lane.

Image-output models are the exception to the custom-model gate on the Gemini
`generateContent` route: when the requested model is known to produce images,
Helm treats it as an exact image request for **any** valid key, selects the
synthetic `image` lane label for telemetry, and skips text classification and the
model-alias shim. This pre-step is suppressed while a key is over-budget and
forced to a degrade lane, so image requests cannot bypass budget enforcement. The
two dedicated image endpoints use the same image-chain semantics outside the text
router.

A direct request that matches the key's `blocked_models` list is rejected before
the image/explicit/classified branches above. Expanded lane chains are filtered by
the same list later; see [Per-key model blocking](#per-key-model-blocking).

Within the classified branch, the resolver applies its own priority-0
short-circuit: if the classifier `decided_by` is `default` (classify() itself
threw — hard fail-open) or `fallback` (eval/rules abstained), the request goes
**straight to the default fallback lane** without re-deriving a lane. Both signals
mean "we are not confident enough to steer," so they collapse to the safe terminal.

The terminal fallback lane is operator-configurable via the admin **System
Settings** (`runtime.default_lane`, hot-applied, default `balanced`). It is used at
**both** fail-open terminals — the classifier short-circuit above and the final
"nothing resolved" sink — **but only if the named lane exists**; otherwise the
resolver defensively prefers `balanced` when present, then the first configured
lane. It does **not** change the
complexity-fallback tiers (`simple→economy / medium→balanced / complex→premium`),
which keep their fixed targets. An unknown lane is rejected (400) at the settings
write boundary, and the current default lane cannot be deleted through the Admin
API. The resolver fallback only protects direct callers or manually inconsistent
configuration; Gateway composition rejects that inconsistency at startup.

Default lanes are deliberately few and easy to reason about. Any selected lane
name that does not exist is skipped (fail-open); the configured terminal must be
one of the lanes in the set.

When `runtime.signal_feedback.enabled` is true, the router performs one
fail-open read of aggregated Agentic Signals after policy/key caps are applied
and before expanding the execution chain. It can only promote a degraded ranked
lane (`economy` or `balanced`) to a stronger ranked lane with healthier aggregate
success/error/fallback rates. It never runs on explicit passthrough,
classifier-default/fallback, policy `use_lane` pins, or over-budget degradation,
and it never escapes policy/key caps.

### Model-alias compatibility shim

For an `allow_custom_model` key, `plan()` runs model-alias compatibility only
after checking exact configured lanes and deployment-known models. Clients that
pin a **fixed vendor model id** — Claude Code's `claude-opus-4-8`,
or an SDK locked to `openai.gpt-5.6` — know neither Helm's lanes nor its provider
aliases, so left alone they would get a `400 unknown model`. The shim rewrites
that inbound `model` field onto a lane (or the `auto` sentinel) **before**
routing, so a fixed-model client routes cleanly while Helm still only exposes the
lane abstraction (principle 6 — the literal vendor id is never sent upstream). A
key **without** `allow_custom_model` does not use the shim at all: its `model`
field is ignored and the request is classified like `auto` (still no `400`).

The map is [`config/model-aliases.yaml`](../config/model-aliases.yaml): a flat
table of vendor model id → a lane name or `auto`. After exact configured names
have had priority, map keys are **case-sensitive**: an exact map key wins;
otherwise the matching `*`-glob with the most literal characters wins (so
`claude-opus-*` beats `claude-*` regardless of order; `*` absorbs any
date/suffix). Targets are boot-validated to a configured lane or `auto`
(fail-closed, principle 2); the file is optional — delete it for no rewrite.

The shim is **operator-authorized** (the operator owns the mapping) but is
**gated on `allow_custom_model`** — honoring a pinned vendor id is a custom-model
capability:

1. It applies **only to `allow_custom_model` keys**. A key **without** that
   capability routes **everything through classification (`auto`)** — its `model`
   field, even a known vendor id, is **ignored** (never a 400) and the alias map
   is not consulted (see "Explicit client model" below — one rule covers explicit
   models, lanes, and alias-mapped ids).
2. It runs only after exact lane/model resolution. An unknown fixed vendor id can
   still map to a lane instead of 400ing, but the mapped lane is **cap-bounded**,
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
3. **Compatibility map**: when neither exact form exists, an exact
   `model-aliases.yaml` key is tried first, then the most-specific wildcard.
   A mapped lane remains policy/key-cap bounded.
4. Over-budget `degrade` (docs/06) suppresses all explicit and compatibility forms
   — the request is forced onto the degrade lane.

Keys **without** `allow_custom_model` never let the `model` field steer the lane
(any value classifies like `auto`); it is recorded in telemetry as
`requested_model`. It is not wholly inert, though — see
[In-chain model promotion](#in-chain-model-promotion) below.

### In-chain model promotion

When a request reaches an expanded lane through classified routing or an
alias-mapped lane, the router checks whether the client's requested model already
appears in that candidate chain. If it does, that candidate is **promoted to the
front**, so the client gets the exact model it asked for, with the rest of the
chain still behind it as fallback. Alias-mapped family lanes normally already
lead with the matching model, but broad compatibility mappings can benefit from
the same reorder.

This is **reorder-only** (route-request.ts, `promoteRequestedModel`): it never
introduces a new candidate, so cost stays bounded by the operator-declared lane
set, and the per-candidate Capability Filter + circuit breaker still gate every
attempt (a promoted head that cannot serve is skipped and the chain falls through
— never worse than the un-promoted order). Matching normalizes both sides to the
official form (lowercase, `.`→`-` version separators), so equivalent dotted and
hyphenated version ids match; the **earliest** in-chain match wins (preserving
operator provider preference). The payoff: Claude Code pinning
`claude-sonnet-5` on a **standard** key now serves the requested
Sonnet instead of the lane's primary.

Promotion is **suppressed** wherever the routing brain deliberately overrode the
client's choice: an over-budget `degrade` (the downgrade must not be bypassable by
naming an in-chain expensive model) and an alias→`auto` rewrite. It does not run
on exact model or exact lane passthrough.

## Lanes

Lanes are defined in [`config/lanes.yaml`](../config/lanes.yaml) and validated by
`LanesConfigSchema` at load time — an invalid file fails the gateway boot
(principle 2). A lane is a declarative chain: a `primary` plus an ordered
`fallback[]`, where each element is either a model **alias** (`provider/model`,
resolved via `config/providers.yaml`) or the name of another lane (expanded
recursively, deduped, cycle-safe). `purpose` is descriptive and
`reasoning_effort` is an active lane-level override.

The optional `constraints` object (`require_tools`, `require_json`,
`require_vision`, `min_context_tokens`, `max_latency_ms`) is schema-validated and
visible to configuration tooling, but the current execution plan does **not**
thread lane constraints into the Capability Filter. Runtime capability checks are
derived from the normalized request and model catalog. Changing a lane constraint
alone therefore does not alter candidate filtering today.

The shipped quality/cost lanes (the three ranked lanes; `LANE_RANK` orders only
these: economy=0 < balanced=1 < premium=2):

```yaml
economy:
  purpose: Cheap and fast for simple tasks
  reasoning_effort: medium
  primary: openai-codex/gpt-5.6-luna
  fallback:
    - openai-codex/gpt-5.4-mini
    - anthropic/claude-haiku-4-5-20251001
    - deepseek/deepseek-v4-flash
    - openrouter/deepseek-v4-flash
    - openrouter/auto
    - zenmux/auto

balanced:
  purpose: Default quality/cost tradeoff
  reasoning_effort: medium
  primary: openai-codex/gpt-5.6-terra
  fallback:
    - anthropic/claude-sonnet-5
    - deepseek/deepseek-v4-pro
    - openrouter/deepseek-v4-pro
    - zenmux/auto
    - openrouter/auto

premium:
  purpose: Strong reasoning and high quality
  reasoning_effort: high
  primary: openai-codex/gpt-5.6-sol
  fallback:
    - xai/grok-4.5
    - anthropic/claude-opus-4-8
    - balanced
```

The lane map must contain at least one lane. `balanced` is the shipped
`runtime.default_lane`, not a schema-mandatory name; an operator may choose another
existing terminal lane and then delete `balanced`.

The shipped task lanes (the lane resolver maps a classified `task_type` onto a
same-named lane). These are **unranked** — incomparable to the quality/cost
lanes, so `applyCaps` treats an unrankable task lane conservatively when an
`allowed_lanes` whitelist is in force (degrading it toward `balanced`):

```yaml
coding:
  purpose: Coding-capable models for code generation / editing
  reasoning_effort: high
  primary: openai-codex/gpt-5.6-sol
  fallback: [premium, balanced]

json:
  purpose: Strict structured-output (JSON) responses
  primary: deepseek/deepseek-v4-flash
  fallback: [openrouter/deepseek-v4-flash, balanced]
  constraints:
    require_json: true

vision:
  purpose: Multimodal / image understanding
  primary: openai-codex/gpt-5.6-terra
  fallback:
    - xai/grok-4.5
    - anthropic/claude-sonnet-5
    - anthropic/claude-opus-4-8
  constraints:
    require_vision: true

tool_use:
  purpose: Reliable function / tool calling
  reasoning_effort: high
  primary: openai-codex/gpt-5.6-sol
  fallback: [premium]
  constraints:
    require_tools: true
```

If no task-specific lane is configured, the resolver falls back to the three
quality/cost lanes by complexity (`simple → economy`, `medium → balanced`,
`complex → premium`).

### Vendor-family lanes

Beyond the 7 generic lanes above, `config/lanes.yaml` ships **13 vendor-family
lanes** — the rewrite targets of the [model-alias compatibility
shim](#model-alias-compatibility-shim):

```text
claude-opus   claude-fable   claude-sonnet   claude-haiku
gpt-5.6       gpt-5.6-sol    gpt-5.6-terra   gpt-5.6-luna
gpt-5.5       gpt-5.4        gpt-5.4-mini
gemini-pro    gemini-flash
```

(22 lanes total when the two image-generation lanes below are included.) These
exist so a client that pins a fixed vendor id lands on that family's real model
instead of the GPT-led `premium` lane. Each one
**leads with the requested vendor's native/subscription alias** — the Claude
lanes with the `anthropic/*` Claude OAuth pool, the GPT lanes with the
`openai-codex/*` subscription, the Gemini lanes with native `zenmux-vertex/*` aliases —
then **degrades into a generic quality lane** (e.g. `claude-opus → premium`,
`gpt-5.4-mini → economy`). An unconnected subscription alias **fails OPEN** (skip
to the next fallback), never a 5xx, so an unbound subscription just serves the
request from the generic-lane backing.

### Provider mix and the `*/auto` tail

The shipped lanes deliberately mix subscription aliases and static API-key
providers. Several quality and task lanes lead with subscription aliases such as
`openai-codex/*` or `anthropic/*` (connect them in admin → Providers), but they
also include static provider fallbacks such as DeepSeek, OpenRouter, and ZenMux.
An unconnected subscription alias is treated as an unavailable
candidate and fails OPEN to the next fallback, never a 5xx by itself.

The `*/auto` aliases (`zenmux/auto`, `openrouter/auto`) sit at the **tails of
cheap/default fallback chains**. They are deliberately JSON-incapable in the
catalog (`jsonOutput: none`), so a strict-JSON request prunes them via the
Capability Filter and lands on a deterministic JSON-capable model — proving the
filter fires on the default config. The same filter discriminates the two JSON tiers: a strict `json_schema`
request additionally prunes `object`-only backends (official DeepSeek →
`no_response_schema_support`) and lands on a `schema`-capable one (e.g. the cheap
`openrouter/deepseek-v4-flash` mirror), while a bare `json_object` request still
serves on the `object` tier.

### Image-generation lanes

The same file ships two image-only chains used by
`POST /v1/images/generations` and `POST /v1beta/interactions`:

```yaml
gpt-image:
  primary: gpt-image-2
  fallback: []

gemini-image:
  primary: google/gemini-3.1-flash-image
  fallback: [gemini-3.1-flash-image, gemini-3-pro-image]
```

These dedicated endpoints accept an exact image model or image-lane name for any
valid API key, without `allow_custom_model` and without text classification. The
normal per-key budget gate, `blocked_models` filter, provider resolution,
capability checks, breaker, and in-chain failover still apply. OpenAI-compatible
image requests and Gemini-native Interactions requests are adapted separately;
the members of one lane should therefore use compatible request semantics.

### OAuth subscription account selection

Lane routing stops at the provider/model alias. For OAuth subscription aliases
(`anthropic/*`, `openai-codex/*`, `github-copilot/*`, and experimental `xai/*`
when connected through Providers),
the provider pool performs a second, narrower choice: which concrete account
serves this request. That choice is **not** a lane rewrite and does not expose the
account as a client-facing model.

The pool excludes accounts that are manually parked (`schedulable: false`), lack
the requested curated model, or are temporarily auto-parked by a usage-limit
cooldown. It then applies the provider's global account-usage strategy:

- `balanced` — keep sticky sessions on the same account, otherwise hash a new
  session from provider-native affinity inputs and fall back to LRU spreading.
- `manual_priority` — sticky hits still win; otherwise use account priority
  first, rotating only within the best eligible priority tier.
- `low_risk` — in the best priority tier, prefer the account with the lowest fresh
  quota pressure; a sticky account in the same tier is kept when it is close
  enough to the best pressure. Stale or missing quota falls back to the normal
  sticky/hash/LRU behavior.
- `use_expiring` — in the best priority tier, prefer usable quota windows that
  will reset soon. A sticky account in the same tier is kept when its score is
  close enough to the best score. Codex reset credits are counted only as
  discounted virtual capacity for this score; selection never spends them.

Sticky affinity is derived from the request shape the upstream client already
sends: device ids, session/conversation metadata, `prompt_cache_key`,
`conversation_id`, `user`, `safety_identifier`, and `previous_response_id` where
present. Helm does not require clients to send a Helm-specific session header for
OAuth account affinity.

If a selected subscription account hits an account-wide limit before useful
output, the pool can retry a sibling account inside the same provider alias. A
confirmed account-wide limit also parks that account until the reset time when a
quota window is known, or for a short cooldown when only a generic 429 is known.
Scoped limits, such as an Anthropic model-specific cap, can retry a sibling for
the current request without globally parking the account.

Telemetry stamps `serving_account` on the final decision only when the final
served alias still belongs to that selected OAuth provider; if the OAuth attempt
falls through to a non-OAuth fallback, the field is cleared. Attempt rows still
carry `provider_attempts[].provider_name` / `provider_attempts[].provider_model`
when known. Selection details such as strategy, sticky/hash reason, capacity
avoidance, and retry attempt are emitted as structured logs (`oauth.pool.select`),
not as DecisionRecord fields.

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
AND of every written field) wins the lane pin and reasoning-effort override. A
policy must declare at least one action — a pin (`use_lane`), a restrict
(`allowed_lanes` whitelist), and/or a reasoning override (`reasoning_effort`).
The file is `.strict()`-validated, so a typo in a field name fails the gateway
boot.

Caps behave differently from pins: while the **first** matching policy wins the
pin and `reasoning_effort`, the `allowed_lanes` whitelist **accumulates**
(intersection) across every matching policy, so a restrict policy placed after a
pin policy still binds.

Two implementation details matter when authoring policies:

- `project_id` remains in the schema for future trusted project routing, but the
  live router always supplies `null`; a policy matching a string `project_id`
  cannot currently match. Client-controlled memory project headers are
  intentionally not trusted as routing authority.
- Policy and API-key `allowed_lanes` are independent restrictions and are reduced
  to one true intersection before lane selection. `null` means unconstrained;
  `[]` means no lane is permitted and produces a structured `invalid_request`
  without contacting a provider. New key/policy writes reject an explicitly empty
  list (use `null` to clear a key cap), while a disjoint intersection still becomes
  `[]` at runtime and fails closed. Direct concrete models remain governed by
  `allow_custom_model` and `blocked_models`; lane restrictions do not silently
  become a concrete-model denylist.

Reasoning effort precedence is explicit: `policy.reasoning_effort` overrides the
selected lane's `reasoning_effort`, which overrides the client's request value.
`none` is a real override and disables the lane/client reasoning effort for that
matched policy.

The shipped policies are intentionally small and explicit. In evaluation order
they pin JSON-contract requests first, then steer selected
`task_type × complexity` cases:

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

```

Policies must stay explicit and inspectable; there is no hidden, hard-to-debug
model scoring behind them. Note that the policy `complexity` field uses the
collapsed routing tiers (`simple | medium | complex`), matching the classifier's
mapped output (see [03](03-classification.md)).

A restrict-only policy is still supported by the schema and engine. For example,
an operator can add a catch-all whitelist to make `premium` unreachable fleet-wide:

```yaml
policies:
  - id: global_economy_cap
    match: {}                              # empty match = every request
    allowed_lanes: [economy, balanced]
```

## Caps: policy intersected with key

Two independent cap layers apply as one effective intersection:

1. **Policy `allowed_lanes`** narrow the resolver's lane choice to a whitelist.
   An unranked task lane (not in `LANE_RANK`) is treated conservatively —
   degraded toward `balanced`, never escalated to the strongest allowed lane.
2. **Per-key caps** are the other non-negotiable bound from the API key's auth
   record. A lane must satisfy both restrictions; disjoint sets reject rather
   than letting either whitelist overwrite the other. A key confined to, for
   example, `[economy]` is therefore honored even over a policy `use_lane` pin.
   See [06](06-auth-and-rate-limits.md).

## Per-key model blocking

`blocked_models` is independent of lane whitelisting. It matches concrete model
ids/aliases case-insensitively, with `*` and `?` glob support:

- a direct matching model request is rejected even when the key cannot use
  explicit passthrough;
- classified, alias-mapped, explicit-lane, and image-lane chains have matching
  candidates removed before execution;
- a lane name itself is not a model blacklist target; block the concrete aliases
  produced by expansion;
- if filtering removes every candidate, routing returns `invalid_request` without
  calling a provider;
- signal feedback will not promote into a lane whose whole expanded chain is
  blocked for the key.

The same cap is enforced by the dedicated Images and Interactions routes.

## Execution model and the two fallbacks

The selected lane is expanded into an ordered candidate chain (primary →
fallback[], with lane references expanded recursively). The gateway execution
adapter (`apps/gateway/src/routes/execute.ts`) then walks the chain, recording
every attempt with its reason and latency:

1. Resolve the alias to its provider/client. An unavailable provider is recorded
   as a skipped candidate.
2. Ask the per-alias circuit breaker first; an `OPEN` circuit is skipped.
3. Apply request-derived capability, protocol-history, candidate-compatibility,
   and exact Anthropic context gates, each with an explicit skip reason.
4. A genuine provider/transport failure before useful output normally records a
   breaker failure and advances. Candidate-specific context/reasoning-history
   rejections become capability skips; deterministic request-shape 4xx errors are
   terminal `invalid_request`; OAuth credential/rate faults isolated to one pooled
   account do not poison the alias-wide breaker.
5. A `:free` alias that returns 429 is skipped without recording a breaker failure
   (free-tier throttling is not a health signal).
6. A client abort terminates the chain as a non-provider fault — it records
   neither a failure nor a success and is **not** counted as
   `all_providers_failed`.
7. Terminal errors preserve the reason: an actionable all-candidate context
   overflow is `invalid_request` (400); no attempted candidate plus only hard
   capability prunes is `capability_unsatisfiable` (422); an empty chain or an
   enabled per-account user-message queue timeout is `lane_unavailable` (503);
   other exhausted chains—including provider failures, unavailable providers, or
   circuit-open candidates—are `all_providers_failed` (502). See
   [07 · Error Model & Observability](07-observability.md).

`fallback_count` counts only **non-skipped** attempts beyond the first (i.e.
candidates actually attempted upstream, whether they succeeded or failed) —
candidates pruned by the Capability Filter or skipped for an OPEN breaker do not
increment it.

This in-chain model swap is the **execution fallback** — it never rewrites the
lane. The **classification fallback** (→ the configured terminal lane, `balanced`
by default) is the separate mechanism
from [03](03-classification.md). Their fields in the decision record are distinct:
classification fallback shows up as `classifier.decided_by` / `fallback_reason`,
while execution fallback shows up as `provider_attempts` / `fallback_count`.
