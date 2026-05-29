# Research Notes

## Manifest

GitHub: https://github.com/mnfst/manifest

Manifest is a smart model router for agents and AI applications. It routes each request to the cheapest model that can handle it.

Useful ideas:

- Local, deterministic complexity scoring.
- 23 dimensions: keyword, structural, and contextual signals.
- Four tiers: simple, standard, complex, reasoning.
- Task-specific detection for coding, web browsing, data analysis, image generation, video generation, social media, email, calendar, and trading.
- Session momentum for short follow-up messages.

What to borrow:

- Cheap local classifier.
- Explainable complexity and task signals.
- Momentum for short follow-ups.

What not to copy blindly:

- Model-market positioning.
- Broad provider exposure as the main product surface.

## Plano

GitHub: https://github.com/katanemo/plano

Plano is an AI-native proxy and data plane for agentic apps. It includes agent orchestration, model routing, filter chains, observability, and signals.

Useful ideas:

- Agent/data-plane framing.
- Filter chain as middleware.
- Semantic aliases and preference-aware routing.
- Agentic Signals for low-cost production feedback.

What to borrow:

- Middleware boundary for Memory / Guardrails.
- Signals as a future feedback layer.
- Lane/alias abstraction.

What not to copy blindly:

- Big platform scope.
- Built-in agent orchestration in MVP.

## Portkey

Website: https://portkey.ai/

Portkey is an enterprise AI gateway / LLMOps platform.

Useful ideas:

- Unified provider gateway.
- Retries, fallback, load balancing, conditional routing.
- Observability, cost, guardrails, and key management.

What to borrow:

- Request tracing and cost dashboard.
- Virtual key management.
- Fallback policy concepts.

What not to copy blindly:

- Enterprise control-plane sprawl in MVP.

## Tingly Box

GitHub: https://github.com/tingly-dev/tingly-box

Tingly Box is a local/self-hosted Agent Gateway and control box. It combines model proxying, OAuth provider reuse, Web UI, remote IM control, agent profiles, guardrails, and usage analytics.

Useful ideas:

- OAuth subscription quota reuse.
- Agent profile management.
- User token vs model token separation.
- Web UI for providers, routes, aliases, and tokens.

What to borrow:

- OAuth provider integration patterns.
- Local control-plane UX ideas.
- Token separation.

What not to copy blindly:

- IM remote control and full agent control box scope.
- Large security surface in MVP.

## Mastra Observational Memory

Issue: https://github.com/EasyMetaAu/llm-router/issues/362
Docs: https://mastra.ai/docs/memory/observational-memory
Research: https://mastra.ai/research/observational-memory

Useful ideas:

- Gateway-level memory.
- Observer and Reflector background agents.
- Stable, cache-friendly memory context.
- Observations and reflections instead of full raw history.

What to borrow:

- Memory as optional middleware.
- `thread/resource/project` memory scopes.
- Observation + reflection pipeline.

What not to copy blindly:

- Memory in MVP core path.
- Dynamic RAG as the default memory strategy.
