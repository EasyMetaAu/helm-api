# Helm API Documentation

This directory holds the current product/technical contract plus clearly labelled
historical reviews, incident records, and design rationale. The numbered current
documents describe the system **as it ships**; code, schemas, route wiring, and
tests remain authoritative when a historical appendix discusses an older state.

## Helm in one paragraph

Helm API is an **open-source, self-hosted** LLM routing gateway (MIT license,
deployed with Docker) — think of it as "**nginx for the LLM world**". It accepts
standard AI API requests on four translated text protocols (OpenAI Chat
Completions, Anthropic Messages, OpenAI Responses, and Google Gemini) — plus a
dedicated OpenAI-Images-compatible image-generation endpoint
(`/v1/images/generations`) and Gemini image surfaces — uses deterministic rules
(optionally aided by a small-model evaluation that is **off by default**) to
classify text requests by task type and complexity, and routes them to a
configurable **lane** rather than to a bare provider alias. Image requests name an
image model or image lane and can fail over inside the configured image chain.
Helm records every routing decision for debugging. Clients only change their
`base_url` and API key. A management interface ships with the gateway for
operations and request debugging; a separate bearer-scoped portal lets each key
holder view only their own usage, requests, connection instructions, and memory.

## Reading order

> **New to the codebase?** [Architecture & Data Flow](architecture.md) draws the
> whole pipeline as sequence, flow, and state diagrams — the fastest way to see
> how a request moves through the system.

| # | Document | Contents |
|---|----------|----------|
| 01 | [Overview & Positioning](01-overview.md) | What Helm is, the nginx analogy, goals & non-goals, the core product loop. |
| 02 | [Architecture](02-architecture.md) | Pipeline, component responsibilities, internal request shape, decision record, config layout, security rules. |
| — | [Architecture & Data Flow](architecture.md) | Visual companion to 02 — Mermaid sequence/flow/state diagrams for the request lifecycle, classification, routing, execution, protocol translation, memory, and OAuth. |
| 03 | [Classification Cascade](03-classification.md) | The three-layer cascade (rules → optional eval → configured default-lane fallback), task detection, the rule engine, small-model eval. |
| 04 | [Routing & Lanes](04-routing-and-lanes.md) | Routing priority, default & task lanes, policies, execution and the two fallbacks. |
| 05 | [Protocol Translation](05-protocol-translation.md) | Shipping text/image routes, four protocol adapters, unified IR, native passthrough, streaming state machines, and current fidelity boundaries. |
| 06 | [Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md) | Mandatory auth, bootstrap/root keys, per-key caps, rate limits, usage budgets, and OAuth subscription quota/reset-credit boundaries. |
| 07 | [Error Model & Observability](07-observability.md) | Structured errors, decision records, payload capture, request list/detail debugging, media/retry surfaces. |
| 08 | [Memory Middleware](08-memory-middleware.md) | The opt-in per-key memory layer (observe / inject) plus background formation. |
| 09 | [Delivery Status & Roadmap](09-roadmap.md) | Current delivered surface, explicit implementation gaps, non-goals, and release acceptance boundary. |
| 10 | [Deployment (Self-hosted / Docker)](10-deployment.md) | Docker deployment, configuration sources, startup behavior, upgrades. |
| 11 | [Admin UI](11-admin-ui.md) | Web console for keys, lanes, policies, classifier, OAuth providers, memory, requests/replay, settings, and cleanup. |
| — | [Self-Service Portal](12-self-service-portal.md) | Implemented `/portal` SPA and bearer-scoped `/portal/api`: own usage/requests/payloads, connection help, memory curation, and isolation boundaries. |
| 12 | [Memory: Forgetting & Tiering](12-memory-forgetting-and-tiering.md) | Short/mid/long-term tiers + deterministic decay, reinforcement, soft-archive, supersede, and retention layered on 08. The shipped memory config enables forgetting; new API keys still default to memory mode `off`. |
| 13 | [Memory Admin & MCP](13-memory-admin-and-mcp.md) | Implemented admin `/memory` page plus optional `/mcp` JSON-RPC server for memory CRUD/search/recall tools, with API-key auth and an optional OAuth 2.1 shim for ChatGPT connectors. |
| 14 | [Memory: Deep Recall](14-memory-deep-recall.md) | Hybrid fact retrieval (`memory_recall`): RRF fusion of vector embedding (sqlite-vec/pgvector), full-text (FTS5 trigram / tsvector, CJK-aware), and forgetting-score. Fail-open, dual-language. Gated by `config.memory.forgetting.facts_retrieval`. |
| — | [Salient-Fact Memory](salient-fact-memory-spec.md) | Implemented opt-in eager fact formation (`config.memory.forgetting.consolidate.eager_facts`, default off), its safety gates, and how it complements the shipped hybrid recall path. |
| — | [Protocol Compatibility](protocol-compatibility.md) | Conservative source/target matrix, native-passthrough boundary, actual guard/warning propagation, capability-gated modalities, `provider_raw`, and known fidelity gaps. |
| — | [LiteLLM Protocol Gap Spec](protocol-translation-litellm-gap-spec.md) | Source-checked compatibility backlog comparing Helm's current protocol surfaces with LiteLLM-style behavior: Responses lifecycle, native passthrough, Gemini helpers, remote media, and MCP/file-search boundaries. |
| — | [Native Passthrough Fidelity Spec](native-passthrough-fidelity-spec.md) | Contract for Anthropic Messages, OpenAI Responses, and Gemini native passthrough: header/body fidelity, allowed mutations, streaming behavior, governance boundaries, telemetry, and tests. |
| — | [Grok Imagine Media Spec](grok-imagine-media-spec.md) | Checkbox-tracked SuperGrok OAuth contract for Grok image generation, image editing compatibility, asynchronous video generation, and pinned subscription-account execution. |
| — | [Grok.com Imagine OAuth Phase 1 Spec](grok-oauth-entitlement-video-phase1-spec.md) | Checkbox-tracked plan for connected Grok subscription accounts to expose their actual Grok.com Imagine image and text-video capabilities through Helm, using the live web protocol and entitlement as the source of truth. |
| — | [Research Notes](research-notes.md) | Historical research appendix: sources and comparisons that informed the implementation; not a current behavior contract. |
| — | [2026-06-20 Memory Review](memory-review-2026-06-20.md) | Historical review refreshed with a current-status preface and links to the shipping memory contract. |
| — | [Opus Context-Overflow Incident](incidents/2026-06-22-opus-context-overflow.md) | Historical incident record; facts about that event are preserved and current behavior is linked separately. |

## Design principles

These keep Helm more focused than its predecessor `llm-router`:

- **Open-source and self-hosted, not SaaS.** MIT-licensed, deployed by Docker,
  for internal use.
- **Expose the lane abstraction, not a model marketplace.** Users choose
  `economy / balanced / premium`; provider aliases are an internal supply-chain
  detail.
- **A small, explainable routing core.** Policies are explicit and inspectable;
  there is no black-box scoring at runtime.
- **Deterministic classification first.** Local rules form Layer 1; the
  small-model eval is off by default and sits behind them.
- **Memory is middleware.** It helps a request be understood; it never rewrites
  lane rules.
- **Every surprising provider choice is explainable from the logs.**

## Status

| Stage | Status |
|-------|--------|
| Specification | Implemented (these documents describe the shipping system) |
| Core gateway (routing, classification, protocol translation, store) | Implemented |
| Admin UI | Implemented |
| API-key self-service portal | Implemented |
| Optional Memory MCP / OAuth shim | Implemented; config-gated |
| Release | Production — see [`package.json`](../package.json) for the current version |
