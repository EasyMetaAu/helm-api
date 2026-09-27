# Memory safety audit — 2026-09-24

Baseline: latest fetched `origin/main`, `fb34e3aceaec463200fe355776e4fea451a2dae4` (`v0.30.15`). The primary checkout is on `main`; fixes were prepared on `codex/memory-audit-20260924` in an isolated worktree.

## Conclusion

The main confirmed risk was **unbounded retained response state**, not a single universal timer/listener leak. Per-frame SSE limits already existed, but did not bound the text, reasoning, tool arguments, annotations, and tool maps retained across many individually small frames. Several optional observation paths also kept unnecessary copies. These confirmed runtime paths are fixed and covered by regression checks.

An absolute no-OOM guarantee is not established. Admission uses memory estimates; V8 heap, native allocations, socket buffers, SQLite, process concurrency, and the host/container limit all matter. No production settings or databases were changed or inspected in this task.

## Findings and changes

| Priority | Confirmed issue | Change |
| --- | --- | --- |
| P1 | Responses output conversion and unary aggregation could accumulate unlimited text/reasoning/tool arguments across small frames. | Account retained state against the existing shared response-work coordinator before append. Hold reservations through terminal serialization; release on completion, failure, and consumer cancellation. |
| P1 | Anthropic conversion retained a second copy of already-forwarded tool arguments. Responses translation did the same. | Remove the copies. Bound tool slots, names, and arguments that genuinely await a later event. |
| P1 | Gemini needed complete function-call arguments but accumulated them without admission. | Preserve the complete-function-call contract and budget cumulative arguments plus slot metadata. |
| P1 | Request-body reads could stay pending after client cancellation, retaining their reader and memory reservation. | Cancel the reader on abort, propagate the abort, remove the listener, and release the reader/reservation on failure. |
| P1 | Admin bodies and Memory/eval self-HTTP responses bypassed shared body-reading protections. | Reuse budgeted incremental reads; keep the lease through JSON parsing/route execution. Admin exhaustion returns 503 with Retry-After. |
| P1 | Native-stream usage capture appended whole response frames, including terminal output snapshots. | Parse frames as they arrive and retain usage counters only. Preserve Anthropic input/cache counters and maximum output usage. |
| P1 | Translated optional Memory observation accumulated full assistant text; its existing bounded counterpart repeatedly scanned the growing string. | Reuse the bounded accumulator and track UTF-8 bytes incrementally. On overflow, omit the optional reconstructed turn while continuing the client stream. |
| P2 | Shared text reads retained all input byte chunks and then allocated a full contiguous copy before decoding. | Decode UTF-8 incrementally, including multibyte characters split across chunks. The final string remains necessary for JSON parsing. |
| P2 | Keyword matcher cache could retain every historical classifier configuration. | Bound it to 1024 entries with FIFO eviction; matching semantics remain unchanged. |

Main implementation locations: `packages/core/src/runtime/{bounded-response,response-work-admission}.ts`, protocol converters under `packages/core/src/protocol/`, `packages/core/src/provider/openai-responses.ts`, and gateway request/observation paths under `apps/gateway/src/`.

## Existing safeguards checked

- HTTP/WebSocket/response work already share live-headroom admission in the server composition root.
- Deferred write queues already bound queued and in-flight bytes, row count, and waiting producers. Focused queue regressions passed.
- SSE incomplete-frame guards, Codex recovery history, and WebSocket pending queues already have bounds. The independent reviewer found no additional confirmed cancellation/listener leak in those reviewed paths.
- Archive downloads already use file streams; session/body reads have paging and byte-budget mechanisms. Storage adapters and browser source patterns were inspected, but no live database or browser heap profile was taken.
- Eval, key, momentum, and model caches already have entry bounds. The exported `InMemoryRateLimitStore` still retains per-key bucket state; current non-test gateway callers use the persisted adapters. An embedding that chooses that in-memory adapter must manage its key lifetime. Blind eviction would weaken rate-limit enforcement, so it was not added.

## Verification

- Regression cases were run red before implementation for cancellation, incremental decoding, admin/self-HTTP admission, cumulative Responses/Gemini state, Anthropic tool slots, optional Memory reconstruction, usage accumulation, keyword eviction, and linear-time UTF-8 accounting.
- **995 distinct focused tests across 19 files passed**: runtime budgets and queues, shared readers, protocol converters, Responses provider and recovery, unary bounds, admin and replay routes, internal self-HTTP, payload capture, message pipeline, and classifier callers.
- Core and gateway TypeScript checks passed. Changed TypeScript files pass Biome and Git whitespace checks.
- An independent read-only P1 review checked retained-byte accounting, lease lifetimes, protocol completion, and usage semantics. Its additional quadratic scanning finding was fixed and regression-tested.

### Isolated streaming probe

Synthetic data only; no upstream API calls. Node `v24.18.0`, `--expose-gc --max-old-space-size=96 --max-semi-space-size=4`:

| Measurement | Result |
| --- | ---: |
| Actual V8 heap limit | 108 MiB |
| Tool argument bytes forwarded | 170.6875 MiB |
| Sampled maximum heap used | 17.20 MiB |
| Sampled maximum RSS | 86.73 MiB |
| Post-GC heap growth | 0.35 MiB |
| Outstanding response-work reservations after completion | 0 |

This demonstrates bounded retention for the tested Anthropic tool-delta forwarding path. It is not a production concurrency soak or a whole-process peak-memory guarantee. Sampling every 128 events can miss short peaks. GC was explicitly invoked in this diagnostic.

Local probe and raw output: `/tmp/helm-memory-audit-20260924/stream-probe.mts` and `stream-probe.json`. Focused test logs: `/tmp/helm-memory-final-tests.log`, `/tmp/helm-memory-cache-green.log`, `/tmp/helm-memory-accumulator-green.log`.

## Deliberate retained buffering and acceptance limits

JSON input still needs complete schema validation/routing; unary JSON output needs parsing; Responses terminal events contain complete output; Gemini tool calls require complete argument objects. Those operations are budgeted rather than silently truncated. Explicit Codex buffered recovery keeps its current bounded semantics because early forwarding would invalidate transparent replay.

This report records local source validation before PR/CI/release/deployment; it is not production acceptance evidence. Remaining operational acceptance is a soak at the actual container/heap limits with realistic concurrent large requests, slow/disconnected clients, recovery-enabled turns, and DB backpressure, measuring RSS/native memory as well as heap. Production configuration changes require separate authorization.
