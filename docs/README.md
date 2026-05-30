# Helm API Documentation

This directory holds the product and technical specifications for Helm API. The repository is **spec-first**: these documents define the MVP scope and architecture, and implementation follows once the scope is locked.

## Reading order

Start at the top and move down. Each document assumes you have read the ones above it.

| # | Document | What it answers |
|---|---|---|
| 1 | [Product Specification](product-spec.md) | What Helm is, who it serves, what is in and out of the MVP. |
| 2 | [Architecture Specification](architecture-spec.md) | How the request flows through components, the internal request shape, and config layout. |
| 3 | [Memory Middleware Specification](memory-middleware-spec.md) | The optional memory layer that sits beside routing, not inside it. |
| 4 | [Research Notes](research-notes.md) | Prior art (Manifest, Plano, Portkey, Tingly Box, Mastra) and what to borrow vs. avoid. |

## What Helm is in one paragraph

Helm API is a configurable intelligent model gateway. It accepts standard AI API requests (OpenAI Chat, Anthropic Messages, OpenAI Responses, Gemini later), classifies each request by task type and complexity, routes it through a configurable **lane** instead of a raw provider alias, executes through primary and fallback providers, and records every routing decision for debugging. Clients only change `base_url` and API key.

## Core product loop

```text
Client request
  -> Protocol Adapter
  -> Auth / API Key
  -> Task Classifier
  -> Policy / Lane Router
  -> Provider Adapter + Fallback
  -> Request Log / Debug UI
```

## Design principles

These keep Helm narrower than its predecessor (`llm-router`), which grew too broad:

- **Sell lanes, not a model marketplace.** Users pick `economy / balanced / premium`. Provider aliases are internal supply-chain detail.
- **Routing core stays small and explainable.** Policy is explicit and inspectable; no black-box model scoring in the runtime decision path.
- **Memory is middleware, not policy.** It helps the request be understood; it never rewrites lane rules.
- **Deterministic classification first.** Local heuristics decide the first routing layer; an LLM/embedding classifier stays behind a feature flag.
- **Every unexpected provider choice must be explainable** from the request log.

## Out of scope for the MVP

A model marketplace, hundreds of public provider aliases, a full RAG product, memory inside routing policy, and agent orchestration. See [Product Specification → Non-goals](product-spec.md#non-goals) for the full list.

## Configuration layout

Runtime behavior is driven by config, not code changes:

```text
config/
  lanes.yaml         # default and task lane definitions
  policies.yaml      # server-side routing policies
  providers.yaml     # provider aliases and credential references
  capabilities.yaml  # model/provider capability metadata
  pricing.yaml       # pricing metadata and overrides
```

See the [Architecture Specification](architecture-spec.md) for how each file feeds the pipeline.

## Status

| Stage | State |
|---|---|
| Specifications | Drafted (these documents) |
| MVP scope lock | Pending |
| Implementation | Not started |
