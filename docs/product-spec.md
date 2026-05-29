# Helm API Product Specification

## One-line definition

Helm API is a configurable intelligent model gateway: it accepts standard AI API requests, detects task type and complexity, routes each request to the right lane, executes through provider adapters, and records complete request logs for debugging.

## Problem

AI application developers do not want to manage hundreds of models, provider quirks, fallback behavior, cost tradeoffs, and long-term routing decisions in every client. They want one API that is cheap, reliable, good enough by default, and debuggable when something goes wrong.

The previous llm-router direction became too broad: too many provider aliases, too much model-market thinking, and too much logic in the routing core. Helm API should be narrower.

## MVP goals

1. Support standard client APIs with minimal migration cost.
2. Classify each request by task type, complexity, and constraints.
3. Route requests through configurable lanes instead of exposing raw provider aliases.
4. Execute each lane through primary and fallback providers.
5. Record every routing decision and provider attempt for debugging.
6. Keep Memory, Guardrails, Signals, agent orchestration, and IM control outside the MVP core.

## Non-goals

- Do not build a model marketplace.
- Do not expose hundreds of provider aliases as the product surface.
- Do not implement a full RAG product in the routing core.
- Do not put Memory directly inside routing policy.
- Do not build a full agent orchestration platform in MVP.
- Do not depend on a black-box LLM classifier for the first routing layer.
- Do not make provider benchmarking the main runtime decision mechanism.

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

## Client API surface

Helm should support standard AI API shapes:

- OpenAI Chat Completions
- Anthropic Messages
- OpenAI Responses
- Gemini API, later

Clients should only need to change `base_url` and API key. The client should not need to know which provider or model executes the request.

## Provider surface

Provider adapters can support:

- OpenAI-compatible providers: OpenRouter, ZenMux, vLLM, DeepSeek, Qwen, local models, custom endpoints
- Anthropic-native
- Gemini-native
- Future OAuth providers such as Claude Code, Codex, Copilot, or similar subscription-backed providers

Provider aliases are internal supply-chain details. They are not the primary user-facing product.

## Routing concepts

### Task classification

Classifier output:

```yaml
complexity: simple | standard | complex | reasoning
task_type: chat | coding | math | writing | extraction | tool_use | vision | web | data
constraints:
  needs_tools: boolean
  needs_json: boolean
  needs_vision: boolean
  long_context: boolean
  low_latency: boolean
  low_cost: boolean
```

Classifier input may use:

- Current user message
- Recent messages
- Tool definitions
- Response format
- Max token target
- Attachments / multimodal metadata
- Optional memory summary when Memory Middleware is enabled

### Lane routing

Routing order:

```text
explicit model/lane
  > server-side custom policy
  > task-specific lane
  > complexity fallback lane
```

Default lanes should be small and understandable.

### Default lanes

```yaml
economy:
  purpose: Cheap and fast for simple tasks
  primary: cheap_model
  fallback: [balanced_model]

balanced:
  purpose: Default quality/cost tradeoff
  primary: default_good_model
  fallback: [premium_model, economy_model]

premium:
  purpose: Strong reasoning and high quality
  primary: best_reasoning_model
  fallback: [balanced_model]
```

### Optional task lanes

```yaml
coding:
  primary: coding_model
  fallback: [premium, balanced]

vision:
  primary: vision_model
  fallback: [premium]

tool_use:
  primary: tool_capable_model
  fallback: [premium]

json:
  primary: strict_json_model
  fallback: [balanced]
```

If a task-specific lane is not configured, the router falls back to the three default lanes.

## Policy configuration

Policies provide server-side customization without changing client code.

Example:

```yaml
policies:
  - match:
      task_type: coding
      complexity: complex
    use_lane: coding

  - match:
      needs_json: true
    use_lane: json

  - match:
      user_id: vip_user
    use_lane: premium

  - match:
      org_id: low_cost_org
    max_lane: balanced
```

Policy must remain explicit and inspectable. It should not hide hard-to-debug model scoring behind magic.

## Execution model

Each lane has a declared ordered chain:

```yaml
lane:
  primary: model_a
  fallback:
    - model_b
    - model_c
  constraints:
    require_tools: true
    require_json: false
    max_latency_ms: 30000
```

Execution rules:

1. Try primary first.
2. Skip candidates that fail capability constraints.
3. On provider error, timeout, rate limit, or circuit-open state, try next fallback.
4. If all candidates fail, return a structured error.
5. Log every attempt with reason and timing.

## Debug UI requirements

Request list should show:

- Time
- API key / user / org
- Requested model
- Route mode: shadow / real
- Classified task type
- Complexity
- Selected lane
- Final model
- Fallback count
- Status
- Latency
- Cost
- Error reason

Request detail should show:

- Raw request metadata and redacted payload summary
- Classifier output
- Matched policy
- Lane candidate chain
- Provider attempts
- Final response metadata or structured error
- Cost breakdown
- Trace ID
- Memory metadata if memory is enabled

## MVP success criteria

- A new client can point an OpenAI-compatible SDK at Helm and get usable routing without custom config.
- Default economy / balanced / premium lanes work out of the box.
- A coding request can route to a coding lane if configured, otherwise fall back to premium or balanced.
- A JSON-constrained request never silently routes to a model that ignores JSON constraints.
- Every unexpected provider choice can be explained from the request log.
