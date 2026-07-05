# Research Notes

> Appendix / reference material: open-source projects studied while designing
> Helm, with what to borrow and what to avoid. We do not copy code — we study the
> approach and architecture and rewrite.

## Manifest

GitHub: <https://github.com/mnfst/manifest>

Manifest is an intelligent model router for agents and AI applications. It routes
each request to the cheapest model that can handle it.

Valuable ideas:

- Local, deterministic complexity scoring.
- 23 dimensions: keyword, structural, and contextual signals.
- Four tiers: simple, standard, complex, reasoning.
- Task-specific detection covering coding, web browsing, data analysis, image
  generation, video generation, social media, email, calendar, and transactions.
- Session momentum for short follow-up messages.

Worth borrowing:

- A cheap local classifier.
- Explainable complexity and task signals.
- Momentum for short follow-up messages.

Do not copy blindly:

- The model-market positioning.
- Making broad provider coverage the product's primary surface.

Landing notes (confirmed after scanning the source):

- The repo is `mnfst/manifest` (TypeScript, NestJS + SolidJS, **MIT**, usable as
  reference). The companion tester is `mnfst/wingman`.
- The "23 dimensions" = 14 keyword dimensions + 9 structural/contextual
  dimensions; keywords are matched in one pass via a trie.
- Four-tier boundaries (`scoring/config.ts`):
  `simple < -0.10 ≤ standard < 0.08 ≤ complex < 0.35 ≤ reasoning`.
- Confidence: `confidence = sigmoid(k=8 · distance to the nearest boundary)`;
  `< 0.45` is treated as uncertain and degrades to standard.
- Hard overrides: `HEARTBEAT_OK` → simple; formal-logic keywords → reasoning;
  presence of tools → floor of standard; `> 50k` tokens → floor of complex;
  `< 50` characters with no complexity signal → simple.
- Session momentum: keeps the last 5 messages per `x-session-key` with a 30-minute
  TTL; for short messages (`< 30` chars) history weight can reach 60%, and for
  `> 100` chars momentum is turned off.
- Task detection: dimension → category mapping + tool-name prefixes
  (`browser_` / `code_` / `gmail_` …) + structural signals (URLs, code blocks
  `≥ 40` chars, file paths, stack traces); the `web_browsing` activation threshold
  is intentionally raised to 3.0.
- **Portable surface**: dimension names/weights/keywords/boundaries/thresholds are
  all data and can be lifted straight into a `classifier.yaml` (~90% of the tuning
  surface); roughly 9 structural scoring functions, regex signals, and override
  control flow need to be implemented in code.

## llm-router probe (origin of the eval small model)

In llm-router's 5-stage pipeline, the second stage — "probe" — is an economy LLM
pre-classifier, and it is the direct reference for Helm's Layer-2 eval.

Designs reused:

- Strict-JSON output + Zod validation; `temperature:0`, non-streaming.
- Double-timeout hardening: a runner-internal `Promise.race` (500/300ms) + an
  independent outer consumer `Promise.race` (250ms).
- Fail-open: a timeout / provider error / circuit-open / parse failure all yield
  `advisory=null`, and the main path continues.
- L1 cache: keyed by `conversation_id`, 60s TTL, LRU of 5000 entries.

What Helm changed:

- The probe is **advisory only** (it does not change routing); Helm's eval is
  **decision-making** — its output selects a lane directly.
- The cache key moves from `conversation_id` to a **content hash** (better for a
  stateless gateway).
- Helm's eval config caps `max_tokens`, has both inner and outer timeouts, and
  fail-opens to `balanced`.
- Helm's eval schema exposes only fields consumed by the implementation; dead
  config fields from the reference design were not copied.

## Protocol translation references

Survey of open-source OpenAI / Anthropic / Responses / Gemini protocol
translators (including streaming SSE), used to design the Protocol Adapter. **We do
not copy code — we rewrite, referencing the approach and architecture** (licensing
is handled separately and is not a selection constraint). A coverage matrix was
compared on "completeness + correctness + architectural clarity".

### Reference benchmark: musistudio/llms

`https://github.com/musistudio/llms` (TypeScript, the translation engine behind
claude-code-router). It is the only project whose entire reason to exist is
protocol translation — the cleanest contract, bidirectional, and already in our
target language.

Why it is the most complete for our specific problem:

- Each protocol = one class implementing a **5-method contract**:
  `transformRequestOut` (native inbound → unified IR), `transformRequestIn` (IR →
  native outbound), `transformResponseIn`, `transformResponseOut`, and `endPoint`
  (the inbound route it owns, e.g. `/v1/messages`,
  `/v1beta/models/:modelAndAction`). Inbound and outbound translation live in the
  same file — one protocol fully described in one place — which is exactly why it
  is rewritable.
- The unified hub = the **OpenAI Chat Completions** shape. Five independent
  implementations (litellm, Portkey, new-api, one-api, Bifrost) all converge on
  the same IR, so this is the de facto standard; choosing it means edge cases can
  be cross-referenced against the other five.
- The **streaming state machine** is the most worth studying and is mature:
  `anthropic.transformer.ts`'s `convertOpenAIStreamToAnthropic` uses a monotonic
  `contentIndex` allocator + a `toolCallIndexToContentBlockIndex` map (the correct
  solution for parallel / streamed tool calls) + temporary-id upgrade-on-arrival +
  idempotent `safeClose/safeEnqueue` guards. This is exactly the class of bug
  litellm got wrong (Gemini `input_json_delta` loss, #25561).

Weaknesses: the Responses API is shallower than litellm and thinly documented
(read the source); single-maintainer (battle-tested via claude-code-router's user
base).

### Correctness spec: BerriAI/litellm

`https://github.com/BerriAI/litellm` (Python). Its architecture is coupled into a
large framework and is unsuitable as a template, but its **edge-case correctness is
the most complete** — use it as the "checklist":

- The only one with **truly complete Responses API translation depth**: Anthropic
  `/v1/messages` → `/responses` item expansion, promoting `tool_use` / `tool_result`
  to top-level items, `budget_tokens` → effort, reasoning items, and compaction
  shape mapping (doc: `anthropic_unified/messages_to_responses_mapping`). Even
  implementing in TS, match its spec-level checklist.
- Correctness helpers: `truncate_tool_name` (OpenAI's 64-char limit vs. Anthropic's
  unlimited — SHA-256 collision-safe truncation + restore on response),
  `_add_additional_properties_false` (recursively forcing OpenAI strict-mode JSON
  schema), and gating `cache_control` by model family.

Third reference: **QuantumNous/new-api** (Go), whose adaptor explicitly exposes
`ConvertOpenAIRequest` / `ConvertClaudeRequest` / `ConvertGeminiRequest`,
validating the any-to-any inbound matrix.

### Source to study (musistudio/llms, `src/transformer/`)

- `anthropic.transformer.ts` — the core. `transformRequestOut` (system array →
  system message, `tool_result` → `role:"tool"`, `tool_use` → `tool_calls`,
  thinking + signature), `convertOpenAIResponseToAnthropic` (finish-reason mapping,
  usage split `input = prompt − cached`), `convertOpenAIStreamToAnthropic` (the
  streaming state machine).
- `gemini.transformer.ts` + `utils/gemini.util.ts` — `alt=sse`, `x-goog-api-key`,
  no tool-call IDs, schema `format` restrictions.
- `openai.transformer.ts` + `openai.responses.transformer.ts` — the hub identity
  transform + the Responses surface.
- `tooluse / reasoning / maxtoken / streamoptions ...transformer.ts` — the
  **stackable cross-cutting behavior transformer** pipeline pattern.
- `index.ts` (the transformer registry) and `server.ts` (how `endPoint` is mounted
  as an inbound route).

### Architecture patterns to lift (the approach, not the code)

1. **One IR = the OpenAI Chat shape** (validated by five independent
   implementations).
2. **One class per protocol, a 5-method contract**, inbound + outbound in one
   file.
3. **Translation always goes `nativeIn → IR → nativeOut`**, never N×N direct
   pairs: N protocols = **2N transform functions, not N²** — the single most
   important design decision.
4. **Streaming = an explicit per-direction state machine** (not passthrough):
   maintain a content-block index allocator, a tool-call-index → block-index map,
   temporary-id → real-id upgrades, and idempotent close guards; deterministically
   emit `message_start → content_block_start/delta/stop → message_delta →
   message_stop`.
5. **Cross-cutting concerns as stackable behavior transformers** (max-token
   clamping, tool-use normalization, reasoning injection) layered on top of the
   protocol transformers.

Additional points (on top of the five above):

- The unified IR extends the OpenAI Chat shape with **optional fields**: thinking /
  reasoning blocks, multipart typed content (image / document), tool-call IDs,
  cache-control, and a `provider_raw` passthrough bag (carrying the upstream native
  `stop_reason` / `usage` so agent clients can reconstruct them).
- If a protocol can act as both inbound (client) and outbound (provider), it is 2N
  transform functions; if the inbound and outbound sets are disjoint, it is N+M
  adapters — either way, everything routes through the hub, never N×N direct.
- Provide a **JSON → SSE synthesizer** for "the client wants streaming but the
  upstream returned a single JSON" (cache hit / non-streaming provider).

**Five streaming / edge-case pitfalls that must be handled:**

1. **finish_reason / stop_reason enum mismatch**: the OpenAI SDK discards the
   entire response (including already-generated content) on an illegal enum;
   collapsing everything to `stop` makes agents silently misjudge. → Map to a legal
   enum **and** store the original value in `provider_raw`.
2. **Token-usage field translation and cache double-billing**: Anthropic's
   `input_tokens` / `cache_read_input_tokens` vs. OpenAI's `prompt_tokens` /
   `prompt_tokens_details.cached_tokens`; in streaming, cache reads were once
   counted as full-price input, causing a ~10× cost error. → Translate explicitly,
   `input = prompt − cached`, and buffer usage in the final streaming event.
3. **Tool-call streaming index/ID coordination**: OpenAI streams by integer index,
   id/name may appear only in the first chunk, and arguments arrive in fragments;
   Anthropic needs a `tool_use` block carrying id + name first, then
   `input_json_delta`. → Maintain an index → block map, synthesize a temporary
   id/name and overwrite it later, and tolerate incomplete JSON (jsonrepair).
4. **Streaming block/part ID and role consistency**: every block must be started
   before delta and stopped after; a delta with no start is silently dropped by
   strict consumers; the first OpenAI delta must carry `role:"assistant"` or
   LangChain will not detect the tool call. → Track open-block state + a close
   guard to prevent "controller already closed".
5. **System prompt and multimodal structure mismatch**: OpenAI puts system in
   `messages[0]`, Anthropic uses a top-level `system` and forbids consecutive
   same-role messages (merge consecutive user/tool_result); image `image_url` vs.
   `source:{base64}` must be split; Gemini has no tool-call IDs (synthesize them)
   and `format` only supports date/date-time.

References:

- <https://github.com/musistudio/llms> — `src/transformer/anthropic.transformer.ts`
- <https://github.com/Portkey-AI/gateway> — `src/handlers/streamHandler.ts`,
  `src/handlers/responseHandlers.ts`
- <https://github.com/BerriAI/litellm> — source of the usage / finish_reason pitfall
  issues
- <https://github.com/maxnowack/anthropic-proxy>

## Plano

GitHub: <https://github.com/katanemo/plano>

Plano is an AI-native proxy and data plane for agentic applications. It includes
agent orchestration, model routing, filter chains, observability, and signals.

Valuable ideas:

- An agent / data-plane framing.
- Filter chains as middleware.
- Semantic aliases and preference-aware routing.
- Low-cost production feedback via Agentic Signals.

Worth borrowing:

- A middleware boundary for Memory / Guardrails.
- Signals as a low-cost feedback layer.
- The lane / alias abstraction.

Do not copy blindly:

- The sprawling platform scope.
- Building in agent orchestration at the MVP stage.

## Portkey

Website: <https://portkey.ai/>

Portkey is an enterprise AI gateway / LLMOps platform.

Valuable ideas:

- A unified provider gateway.
- Retries, fallbacks, load balancing, conditional routing.
- Observability, cost, guardrails, and key management.

Worth borrowing:

- Request tracing and a cost dashboard.
- Virtual key management.
- The concepts behind fallback strategies.

Do not copy blindly:

- Rolling out an enterprise control plane at the MVP stage.

## Tingly Box

GitHub: <https://github.com/tingly-dev/tingly-box>

Tingly Box is a local / self-hosted Agent Gateway and control box. It combines a
model proxy, OAuth provider reuse, a web UI, remote IM control, agent profiles,
guardrails, and usage analytics.

Valuable ideas:

- Reusing OAuth subscription quotas.
- Agent profile management.
- Separation of user tokens and model tokens.
- A web UI to manage providers, routing, aliases, and tokens.

Worth borrowing:

- The OAuth provider integration pattern.
- The UX ideas for a local control plane.
- Token separation.

Do not copy blindly:

- IM remote control and the full agent-control-box scope.
- Introducing a large security surface at the MVP stage.

## Mastra Observational Memory

- Issue: <https://github.com/EasyMetaAu/llm-router/issues/362>
- Docs: <https://mastra.ai/docs/memory/observational-memory>
- Research: <https://mastra.ai/research/observational-memory>

Valuable ideas:

- Gateway-level memory.
- Observer and Reflector background agents.
- A stable, cache-friendly memory context.
- Replacing the full raw history with observations and reflections.

Worth borrowing:

- Memory as an optional middleware.
- `thread` / `resource` / `project` memory scopes.
- The observation + reflection pipeline.

Do not copy blindly:

- Putting memory in the MVP core path.
- Making dynamic RAG the default memory strategy.

> See [08 · Memory Middleware](08-memory-middleware.md) for how these ideas map to
> Helm: observe and inject are both implemented end-to-end with a background
> Observer/Reflector worker (opt-in); only the real LLM summarize/merge step
> remains a deterministic stub.
