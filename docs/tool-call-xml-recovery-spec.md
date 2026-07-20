# Tool-Call XML Recovery Spec

> Status: proposed · Owner: Lukin · For implementation by Codex
> Scope: recover tool calls that an upstream model leaks as literal `<invoke>` XML
> text instead of a structured `tool_use` block, so the client never sees raw XML.

## 1. Problem

Claude Code (and any Anthropic-Messages client) occasionally receives an assistant
message where a tool call was emitted as **plain text** in this exact bare form:

```
<invoke name="Bash">
<parameter name="command">git status</parameter>
<parameter name="timeout">600000</parameter>
</invoke>
```

instead of as a structured `tool_use` content block. The client then prints the raw
XML instead of executing the tool. Users see garbage like `<invoke name="...">` in
the terminal.

### Root cause (confirmed by investigation, not assumed)

Evidence gathered from the production telemetry DB (`la.atmy.work:/opt/helm-api/data/helm.db`,
table `telemetry`) and from real leaked samples in local Claude Code session logs:

- The Lukin key (`helm_live_KOGN`, `allow_custom_model=1`) requesting `claude-opus-4-8`
  is routed to the `claude-opus` lane and served by the **real Anthropic** upstream via
  **native passthrough** (`passthrough_used=1`, `source_protocol=target_provider_protocol=anthropic_messages`,
  `provider_name=anthropic`, `n_attempts=1` — **no fallback/degradation**).
- Real leaked samples are all `model=claude-opus-4-8`, message-level `stop_reason="tool_use"`,
  with the call body sitting inside a single **text** block, fully closed and balanced
  (1 `<invoke>` open, 1 `</invoke>` close).
- Conclusion: the **real Anthropic upstream (Opus 4.8) intermittently emits the tool call
  as `<invoke>` text**. This matches multiple open `anthropics/claude-code` GitHub issues
  reported by users on the direct Anthropic API with no gateway. Helm forwards the bad
  response byte-for-byte on the passthrough path, so the leak reaches the client.

**This is NOT a Helm routing/translation bug and NOT a Claude Code client bug.** Helm is
faithfully relaying a malformed upstream response. But Helm is the only place we can fix
it for our users, so we add a defensive recovery layer.

### Where the leak actually happens

| Path | Serves | Leak seen here? |
|------|--------|-----------------|
| **Native passthrough** (`anthropic.ts` `nativePassthroughStream` → `readAnthropicSSERaw`) | claude-opus-4-8 direct to Anthropic | **YES — this is the real one** |
| **OpenAI→Anthropic translation** (`stream.ts` `convertOpenAIStreamToAnthropic`) | fallback to `gpt-5.6-sol` etc. | Possible in future if GPT backend emits XML text |
| **Non-stream** (`response.ts` `toContentBlocks` / `transformResponseIn`) | non-streaming requests | Possible, same mechanism |

Decision (approved): **fix all three paths.** Passthrough is mandatory (real leak);
translation + non-stream are defensive completeness.

## 2. Confirmed grammar

Bare Anthropic tool-call surface syntax. **No `antml:` namespace prefix, no
`<function_calls>` wrapper** in the observed leaks (tolerate an optional `antml:` prefix
defensively):

- Open: `<invoke name="TOOL">`
- Param: `<parameter name="KEY">RAW TEXT VALUE</parameter>` (values are raw text)
- Close: `</invoke>`

Multiple `<invoke>` blocks may appear in one text. In real leaks the whole block is
complete within a single text block.

## 3. Detection signal (low false-positive)

Recover a tool call ONLY when ALL hold:

1. Message-level `stop_reason == "tool_use"` (the upstream already flagged it as a tool call).
2. A text block contains a **closed** `<invoke name="X">…</invoke>`.
3. `X` matches a tool **declared in the request** (whitelist guard).

If any fails, leave the text untouched. This prevents swallowing legitimate prose that
happens to contain angle brackets, and avoids acting on partial/unclosed markup.

## 4. Shared parser (single source of truth)

New module `packages/core/src/protocol/anthropic/tool-xml-recovery.ts`, pure and
dependency-free, used by all three paths. Suggested surface:

```ts
export interface RecoveredToolCall { name: string; input: Record<string, unknown>; }
export type RecoverySegment =
  | { type: "text"; text: string }
  | { type: "tool_use"; call: RecoveredToolCall };

// Cheap gate for the common (no-leak) path.
export function hasInvokeStart(text: string): boolean;

// Split text into ordered segments, lifting each CLOSED, whitelisted <invoke> into a
// tool_use segment and keeping all other text verbatim. Returns null when there is
// nothing to recover, so callers keep the original text untouched with zero cost.
export function recoverToolCallsFromText(
  text: string,
  declaredTools: ReadonlySet<string>,
): RecoverySegment[] | null;
```

Parsing rules:

- Match `<invoke name="X">…</invoke>` with a **lazy** body so multiple blocks don't merge.
- Each `<parameter name="K">V</parameter>` → `input[K] = coerce(V)`.
- **coerce(V):** attempt `JSON.parse` only when `V` (trimmed) looks like a JSON scalar/
  container (`true|false|null`, a digit/`-`, `{`, `[`, `"`); on success use the typed value,
  else keep the raw string. A bare word like `Paris` stays the string `"Paris"`.
- Skip (leave as text) any invoke whose `name` is not in `declaredTools`.
- Skip (leave as text) any unclosed invoke.
- Return `null` if `declaredTools` is empty, if there is no `<invoke>` start, or if nothing
  was recovered — so the normal path is byte-faithful and does no real work.

> A reference implementation of this module + a 9-case vitest suite (all green) was
> prototyped and then reverted to keep the tree clean. Codex may re-derive it from this
> spec. Watch out: writing the literal `</parameter>`/`antml:invoke` tags in a heredoc/
> template can hit tooling truncation — build the `antml:` test fixture by string
> concatenation (`const ns = "antml:"`) to avoid it.

## 5. Path 1 — native passthrough (the real fix)

File: `packages/core/src/provider/anthropic.ts`.
`nativePassthroughStream` (~1771) currently yields raw Anthropic SSE via
`readAnthropicSSERaw` (~1793), byte-for-byte.

Add an **opt-in recovery filter** wrapping the raw SSE generator:

- Parse the Anthropic SSE event stream (`message_start`, `content_block_start/delta/stop`,
  `message_delta` carrying `stop_reason`, `message_stop`).
- Buffer **text** content-block deltas until `content_block_stop` (guards against an
  `<invoke>` split across SSE chunks, even though real leaks are single-block).
- On block completion, if `stop_reason == "tool_use"` and the buffered text yields a
  whitelisted recovery, re-emit that block as: any leading text as a `text` block, then a
  `tool_use` block (`content_block_start {type:tool_use,id,name,input:{}}` +
  `input_json_delta` with the JSON args + `content_block_stop`), then any trailing text.
- **Hard requirement:** when there is no leak, forwarding must stay effectively
  byte-identical. Only buffer/rewrite once the detection signal is live; otherwise pass
  through untouched. Do not regress the `readAnthropicSSERaw` idle-timeout / stall
  semantics.
- Mint a synthetic tool_use id (reuse the existing `clientToolUseId`/`toolu_synthetic_*`
  convention from `stream.ts`).
- Thread declared tool names in from the request (available at the passthrough call site).

## 6. Path 2 — translation stream

File: `packages/core/src/protocol/anthropic/stream.ts`,
`convertOpenAIStreamToAnthropic`. Text handling ~442-453 (`delta.content` →
`textDeltaEvent`).

- Add `toolNames?: readonly string[]` to `OpenAIToAnthropicStreamOptions` (~124-129);
  pass it from the call site `apps/gateway/src/routes/messages-pipeline.ts` (~1212) using
  `ir.tools`.
- Buffer text once a `<invoke` open token appears; on close (or at stream-end
  finalization ~537-565) lift into a tool_use block using the SAME
  START→`input_json_delta` shape as the existing `tool_calls` block (~456-496), reusing
  `allocBlock`, `clientToolUseId`, `inputJSONDeltaEvent`, `textDeltaEvent`.
- Set `state.finishReason` so the terminal `message_delta` reports `tool_use`.
- If unclosed at stream end, flush the buffered text verbatim (never swallow).

## 7. Path 3 — non-stream

File: `packages/core/src/protocol/anthropic/response.ts`.

- `toContentBlocks` (~318-396), text build ~364-373: scan the full text (no chunk
  boundaries); on a whitelisted closed `<invoke>`, split the text and push a `tool_use`
  block (shape like `toToolUseBlock` ~398-408).
- Override `stop_reason` to `tool_use` in `transformResponseIn` (~415) when a recovery
  happened.
- **Plumbing note:** `transformResponseIn(ir: IRResponse)` today only receives the
  *response* IR; declared request tools are not threaded in. Adding the whitelist here
  requires passing request tool names through `transformResponseOut`
  (`anthropic/index.ts` ~80) to `transformResponseIn`. This is the largest structural
  change of the three — do it only after Paths 1–2 land, or gate it if the request tools
  are not readily available.
- Reuse `parseToolArguments`/`repairJson` (~258-314, currently module-private — export
  them) if you prefer JSON-string assembly over the `coerce` approach; keep ONE approach
  for consistency with the shared parser.

## 8. Safety boundaries (hard requirements)

1. **Whitelist** — only recover invoke names present in the request's declared tools.
2. **Closed only** — only recover complete `<invoke>…</invoke>`; unclosed → emit text verbatim.
3. **No-leak untouched** — responses without a leak must be byte-faithful / unchanged.
4. **Order preserved** — surrounding legitimate text kept in original order (text + tool_use + text).
5. **Feature flag** — gate behind a runtime setting `tool_call_xml_recovery`, **default true**,
   following the `native_protocol_passthrough` pattern
   (`packages/shared/src/config/runtime-settings.schema.ts`, wired in
   `apps/gateway/src/server.ts`). Lets ops disable it instantly if it ever misbehaves.

## 9. Tests (mandatory; vitest; `CI=true`, single-file only — never bare `pnpm test`/`vitest`)

Shared parser — `packages/core/src/protocol/anthropic/tool-xml-recovery.test.ts`:
single invoke; multiple params with type coercion; surrounding text preserved; multiple
invokes; name not whitelisted → null; unclosed → null; ordinary text → null; no tools → null;
`antml:` variant (build fixture via string concat).

Stream — extend `stream.test.ts` (helpers `feed`/`collect`/`textChunk`; tool streaming
ref ~128-207): leaked `<invoke>` across text chunks recovers to tool_use with correct
terminal `stop_reason`; no-leak stream unchanged.

Non-stream — extend `response.test.ts` (`transformResponseIn` ~89, tool_use ref ~151-173,
stop_reason ~37-67): leaked text recovers to tool_use block + `stop_reason=tool_use`;
no-leak response unchanged.

Run exactly:

```
cd /Users/lukin/Projects/llm-router-packages/helm-api
CI=true pnpm exec vitest run packages/core/src/protocol/anthropic/tool-xml-recovery.test.ts
CI=true pnpm exec vitest run packages/core/src/protocol/anthropic/stream.test.ts
CI=true pnpm exec vitest run packages/core/src/protocol/anthropic/response.test.ts
pnpm lint
```

## 10. Deliverable

Branch `fix/tool-call-xml-recovery`: shared module + three paths + runtime flag + tests,
all green, lint clean. Match the codebase's meticulous "pit/principle" comment style.
Report files changed, the flag name, test results, and any spec deviations.

## 11. Verify against a real leak (optional but recommended)

Real leaked samples exist in local Claude Code session logs. To find more raw examples of
the exact leaked bytes:

```
grep -rlE '<invoke name=|<parameter name=' ~/.claude/projects --include='*.jsonl'
```

Confirm the recovered `tool_use.input` matches what the `<parameter>` values intended.
