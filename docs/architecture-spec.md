# Helm API Architecture Specification

## Architecture overview

```text
Client
  -> API Gateway
  -> Protocol Adapter
  -> Auth Resolver
  -> Optional Memory Middleware
  -> Task Classifier
  -> Policy Engine
  -> Lane Resolver
  -> Capability Filter
  -> Circuit Breaker
  -> Provider Executor
  -> Telemetry / Request Log
```

## Components

### API Gateway

Responsibilities:

- Accept standard API requests.
- Normalize headers and request IDs.
- Apply request size and timeout limits.
- Forward to the correct protocol adapter.

### Protocol Adapter

Responsibilities:

- Normalize OpenAI / Anthropic / Responses / future Gemini requests into one internal request shape.
- Convert provider responses back into the requested client protocol.
- Preserve streaming semantics.

### Auth Resolver

Responsibilities:

- Resolve API key identity.
- Attach account, org, user, and permission metadata.
- Never store plaintext API keys in telemetry.
- Record key source and key ID so each request can be traced back to a key.

### Task Classifier

Responsibilities:

- Compute `task_type`, `complexity`, and `constraints`.
- Use deterministic local heuristics first.
- Allow future LLM/embedding-based classifier behind a feature flag.
- Return explainable signals for debug UI.

Initial classifier sources:

- Manifest-style local complexity scoring.
- Task-specific keyword/tool detection.
- Request fields such as tools, response format, attachments, max tokens.
- Optional memory summary when memory is enabled.

### Policy Engine

Responsibilities:

- Apply explicit server-side policy rules.
- Resolve org/user/project overrides.
- Enforce caps such as `max_lane` or allowed lanes.
- Produce a single matched policy record for telemetry.

### Lane Resolver

Responsibilities:

- Select the target lane.
- Use default lanes when task-specific lanes are absent.
- Preserve declared primary/fallback order.
- Avoid scoring `*/auto` provider aliases above explicit primary models.

### Capability Filter

Responsibilities:

- Check tools support.
- Check JSON / structured output support.
- Check vision / multimodal support.
- Check context length.
- Check streaming support.
- Return explicit skip reasons.

### Circuit Breaker

Responsibilities:

- Track per-provider/model health.
- Skip `OPEN` circuits.
- Use `HALF_OPEN` probe lock before real calls.
- Record failures before first valid provider chunk.
- Record success only after a valid response/chunk.
- Treat client abort as non-provider failure.

### Provider Executor

Responsibilities:

- Execute providers in lane order.
- Translate requests to provider-native protocol.
- Handle streaming and non-streaming paths consistently.
- Return structured attempt records.

### Telemetry / Request Log

Responsibilities:

- Persist request-level routing decisions.
- Persist provider attempt chain.
- Persist auth/key identity metadata.
- Persist cost and latency information.
- Redact secrets and private payload fields.

## Internal request shape

```yaml
request_id: string
protocol: openai_chat | anthropic_messages | openai_responses | gemini
account_id: string
api_key_id: string
user_id: string | null
org_id: string | null
requested_model: string
messages: array
tools: array | null
response_format: object | null
attachments: array | null
max_tokens: number | null
stream: boolean
metadata:
  conversation_id: string | null
  thread_id: string | null
  resource_id: string | null
  project_id: string | null
  memory_mode: off | observe | inject
```

## Decision record

```yaml
request_id: string
route_mode: shadow | real
requested_model: string
classifier:
  task_type: string
  complexity: string
  constraints: object
  explanation: array
policy:
  matched_policy_id: string | null
  reason: string
lane:
  selected_lane: string
  candidate_chain: array
provider_attempts:
  - alias: string
    skipped: boolean
    skip_reason: string | null
    status: ok | error
    error_class: string | null
    latency_ms: number
    cost_usd: number | null
final:
  model_alias: string | null
  provider_model: string | null
  status: ok | error
  error_reason: string | null
```

## Configuration files

Expected config split:

```text
config/
  lanes.yaml           # default and task lane definitions
  policies.yaml        # server-side routing policies
  providers.yaml       # provider aliases and credentials references
  capabilities.yaml    # model/provider capability metadata
  pricing.yaml         # pricing metadata and overrides
```

## Safety rules

- Production routing only uses active lanes and active allowlists.
- Catalog metadata never directly enters runtime selection.
- Provider auto aliases are fallback tails unless explicitly configured otherwise.
- Generated catalogs are supply-chain input, not policy.
- Debug UI must explain why a provider was selected or skipped.
- Secrets must never be logged in plaintext.
