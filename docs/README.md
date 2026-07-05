# Helm API Documentation

This directory holds the product and technical specification for Helm API; the
numbered documents below describe the system **as it ships** — read them in order.

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
operations and request debugging.

## Reading order

> **New to the codebase?** [Architecture & Data Flow](architecture.md) draws the
> whole pipeline as sequence, flow, and state diagrams — the fastest way to see
> how a request moves through the system.

| # | Document | Contents |
|---|----------|----------|
| 01 | [Overview & Positioning](01-overview.md) | What Helm is, the nginx analogy, goals & non-goals, the core product loop. |
| 02 | [Architecture](02-architecture.md) | Pipeline, component responsibilities, internal request shape, decision record, config layout, security rules. |
| — | [Architecture & Data Flow](architecture.md) | Visual companion to 02 — Mermaid sequence/flow/state diagrams for the request lifecycle, classification, routing, execution, protocol translation, memory, and OAuth. |
| 03 | [Classification Cascade](03-classification.md) | The three-layer cascade (rules → optional eval → balanced fallback), task detection, the rule engine, small-model eval. |
| 04 | [Routing & Lanes](04-routing-and-lanes.md) | Routing priority, default & task lanes, policies, execution and the two fallbacks. |
| 05 | [Protocol Translation](05-protocol-translation.md) | Protocol Adapter design (OpenAI Chat, Anthropic, OpenAI Responses, Google Gemini), the unified IR, the streaming state machine, the footguns that are handled. |
| 06 | [Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md) | Mandatory auth, bootstrap/root keys, per-key caps, rate limits, usage budgets, and OAuth subscription quota/reset-credit boundaries. |
| 07 | [Error Model & Observability](07-observability.md) | Structured errors, decision records, payload capture, request list/detail debugging, media/retry surfaces. |
| 08 | [Memory Middleware](08-memory-middleware.md) | The optional memory layer (observe / inject). |
| 09 | [Roadmap](09-roadmap.md) | Phased roadmap and success criteria. |
| 10 | [Deployment (Self-hosted / Docker)](10-deployment.md) | Docker deployment, configuration sources, startup behavior, upgrades. |
| 11 | [Admin UI](11-admin-ui.md) | Web console for keys, lanes, policies, classifier, OAuth providers, memory, requests/replay, settings, and cleanup. |
| 12 | [Memory: Forgetting & Tiering](12-memory-forgetting-and-tiering.md) | Short/mid/long-term tiers + a deterministic forgetting strategy (decay, reinforcement, soft-archive, supersede) layered on 08. Shipped and enabled in the bundled `config/memory.yaml`; the schema default remains `false` for fail-safe config loading. |
| 13 | [Memory Admin & MCP](13-memory-admin-and-mcp.md) | Implemented admin `/memory` page plus optional `/mcp` JSON-RPC server for memory CRUD/search/recall tools, with API-key auth and an optional OAuth 2.1 shim for ChatGPT connectors. |
| 14 | [Memory: Deep Recall](14-memory-deep-recall.md) | Hybrid fact retrieval (`memory_recall`): RRF fusion of vector embedding (sqlite-vec/pgvector), full-text (FTS5 trigram / tsvector, CJK-aware), and forgetting-score. Fail-open, dual-language. Gated by `config.memory.forgetting.facts_retrieval`. |
| — | [Salient-Fact Memory](salient-fact-memory-spec.md) | **Implemented, opt-in** (`config.memory.forgetting.consolidate.eager_facts`, default off). Why a short "remember X" turn formed no cross-session memory, and the fix: eager fact extraction decoupled from compaction + deterministic scope-filtered fact injection (the formation+injection layer below the deferred P8 retrieval; no embeddings, no migration). |
| — | [Protocol Compatibility](protocol-compatibility.md) | Per-pair data-loss matrix, the `n>1` cap / `data_loss` warning policy, the `provider_raw` passthrough list, capability-gated modalities, and the litellm parity scorecard. |
| — | [LiteLLM Protocol Gap Spec](protocol-translation-litellm-gap-spec.md) | Source-checked compatibility backlog comparing Helm's current protocol surfaces with LiteLLM-style behavior: Responses lifecycle, native passthrough, Gemini helpers, remote media, and MCP/file-search boundaries. |
| — | [Native Passthrough Fidelity Spec](native-passthrough-fidelity-spec.md) | Contract for Anthropic Messages, OpenAI Responses, and Gemini native passthrough: header/body fidelity, allowed mutations, streaming behavior, governance boundaries, telemetry, and tests. |
| — | [Research Notes](research-notes.md) | Appendix: open-source references and comparisons for the rule engine, protocol translation, probes, etc. |

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
| Release | Production — see [`package.json`](../package.json) for the current version |
