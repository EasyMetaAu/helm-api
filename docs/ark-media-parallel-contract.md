# Ark media first-batch integration contract

Status: initial coordination contract, 2026-10-14. Owner: coordinator chat.
Baseline: f0d962692f97b18fb8ed118c3c1991fbfe0d1770.

The user approved the development plan and parallel Codex App chats. Work remains local, uncommitted, and offline. No live provider credentials are part of a task packet.

## Separate write scopes

- T01 owns new `packages/shared/src/request/ark-media-schema.ts`, its tests, and `docs/ark-media-contract.md` in its own worktree. Do not modify existing Grok schemas, barrel exports, catalog/config schemas, gateway, manifests, lockfile, implementation-notes, or central status ledger; report necessary integration edits to coordinator.
- T02 owns new `packages/core/src/provider/ark.ts`, `ark.test.ts`, and `docs/ark-sdk-transport-evidence.md` in its own worktree. Changes to `packages/core/package.json` and `pnpm-lock.yaml` are allowed only for the exact OpenAI SDK dependency, with no unrelated updates. Do not modify core/shared barrel exports, existing provider interfaces, gateway, implementation-notes, or central ledger.
- Coordinator owns shared exports/interfaces, gateway composition, task board, integration and final acceptance. No worker edits another worktree. Commits are now explicitly authorized by the user. No pushes/PRs/releases/paid requests.

## Parallelizable seams

T01 produces strict Zod exports `ArkImageGenerationRequestSchema`, `ArkVideoGenerationRequestSchema`, `ArkThreeDGenerationRequestSchema`, and types inferred from those schemas. Include upstream input and response contract fixtures. Keep a standalone schema; coordinator later wires public aliases/model mapping and existing route unions. Clarify unsupported inputs explicitly. Never silently strip unsupported safety-relevant fields.

T02 implements `createArkMediaClient(deps)` using existing `ProviderConfig`/`ProviderCallOptions`/`OpenAIClientDeps` types when compatible. Its isolated return interface has `imageGeneration(body, opts?)`, `videoGeneration(body, opts?)`, `videoRetrieve(id, opts?)`, `threeDGeneration(body, opts?)`, `threeDRetrieve(id, opts?)`; bodies/results are Record<string, unknown> at the transport seam, boundary schemas owned by T01. Do not force this media-only adapter to implement unrelated chat methods. Coordinator will compose it with ProviderClient as appropriate.

Image requests preserve Ark's body and result. Video/3D methods use `/contents/generations/tasks` and `/{encoded id}` and return raw Ark shape; task normalization and ownership are gateway responsibilities. T02 must not independently invent route status mappings or public task IDs.

Use OpenAI-compatible methods first, then documented SDK `post/get` custom endpoints. The existing SDK probe confirms generic transport feasibility, not production acceptance. If a real unsupported semantic requires handwritten TypeScript, document failure evidence and official SDK source/version before implementing the smallest missing piece. No Python/Go service.

## Shared risk invariants

API-key credentials only in environment/runtime. Paid create has zero automatic retry/fallback, including connection errors, HTTP 503 and redirects that could leak authorization. Errors must distinguish definite rejection from uncertain outcome. Keep cancellation, response/body admission limits, proxy transport, secret redaction and existing telemetry capture contracts. Reuse core bounded-response helpers; do not let SDK JSON parsing bypass limits. Test errors/oversized bodies as well as successful bodies.

Supported media are the approved four exact model IDs; there is no chat fallback or automatic model substitution. Prioritize a minimum vertical slice. New schema must account for Seedream Flash/Pro no streaming/search/sequential output; optional prompt for automatic layer decomposition; Seedance multimodal and first/last-frame combinations; GLB single-image Seed3D. Source uncertain facts from official docs, do not infer them from old Seedream/Seedance variants.

## Evidence and handoff

TDD red first, green next. CI=true targeted tests, default 10 minute command budget; no broad test runs or paid API use. Keep command logs outside repository under the research directory with a unique task prefix. Report actual worktree path, changed-file list, red/green evidence, result and unresolved constraints. Mark own deliverable ready for coordinator review, not overall plan complete. Do not create further chats or agents.
