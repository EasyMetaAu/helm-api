# Helm API Documentation

This directory holds the product and technical specification for Helm API; the
numbered documents below describe the system **as it ships** — read them in order.

## Helm in one paragraph

Helm API is an **open-source, self-hosted** LLM routing gateway (MIT license,
deployed with Docker) — think of it as "**nginx for the LLM world**". It accepts
standard AI API requests on four inbound protocols (OpenAI Chat Completions,
Anthropic Messages, OpenAI Responses, and Google Gemini), uses deterministic
rules (optionally aided by a small-model evaluation that is **off by default**)
to classify each request by task type and complexity, and routes it to a
configurable **lane** rather than to a bare provider alias. It executes the lane
through a primary plus fallback providers and records every routing decision for
debugging. Clients only change their `base_url` and API key. A management
interface ships with the gateway for basic rule management.

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
| 06 | [Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md) | Mandatory auth, the bootstrap key, key management, per-key rate limits. |
| 07 | [Error Model & Observability](07-observability.md) | Structured errors, the error-class table, the Debug UI. |
| 08 | [Memory Middleware](08-memory-middleware.md) | The optional memory layer (observe / inject). |
| 09 | [Roadmap](09-roadmap.md) | Phased roadmap and success criteria. |
| 10 | [Deployment (Self-hosted / Docker)](10-deployment.md) | Docker deployment, configuration sources, startup behavior, upgrades. |
| 11 | [Admin UI](11-admin-ui.md) | Web console, rule management, HTTP Basic auth. |
| 12 | [Memory: Forgetting & Tiering](12-memory-forgetting-and-tiering.md) | Short/mid/long-term tiers + a deterministic forgetting strategy (decay, reinforcement, soft-archive, supersede) layered on 08. **Shipped but opt-in** — gated by `config.memory.forgetting.enabled` (schema default `false`); with it off, runtime is byte-identical to before. |
| — | [Protocol Compatibility](protocol-compatibility.md) | Per-pair data-loss matrix, the `n>1` cap / `data_loss` warning policy, the `provider_raw` passthrough list, capability-gated modalities, and the litellm parity scorecard. |
| — | [LiteLLM 协议互译缺口修复 Spec](protocol-translation-litellm-gap-spec.md) | 基于本地 LiteLLM 参考实现和 wiki 对照生成的四协议互译缺口修复计划：Anthropic provider_raw/空文本块、Responses continuation/lifecycle/stream prelude、Gemini countTokens/schema、远程媒体与 MCP/file_search。 |
| — | [原生直通保真规范](native-passthrough-fidelity-spec.md) | Anthropic Messages 和 OpenAI Responses 原生直通的中文设计草案：header/body 保真、允许的修改、流式策略、治理边界、CRS 借鉴项和验收标准。 |
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
