import { z } from "zod";

// Internal request structure — the normalized input contract for the whole
// pipeline. Protocol Adapters map every client protocol to THIS shape. Per
// CLAUDE.md, the Zod schema is the single source of truth; types come from
// z.infer (no hand-written interfaces). See docs/02-architecture.md.

// Matches docs/02 protocol enum one-for-one.
export const ProtocolSchema = z.enum([
  "openai_chat",
  "anthropic_messages",
  "openai_responses",
  "gemini",
]);

export const MemoryModeSchema = z.enum(["off", "observe", "inject"]);

// MVP does not deep-validate message/tool internals: keep the normalized shape
// open to avoid prematurely locking per-protocol differences (narrowed later in
// the docs/05 protocol-translation tasks).
const MessageSchema = z.looseObject({ role: z.string(), content: z.unknown() });

export const RequestMetadataSchema = z.object({
  conversation_id: z.string().nullable(),
  // Memory fields below are reserved-only in the MVP, not consumed (docs/08).
  thread_id: z.string().nullable(),
  resource_id: z.string().nullable(),
  project_id: z.string().nullable(),
  memory_mode: MemoryModeSchema,
});

export const InternalRequestSchema = z.object({
  request_id: z.string().min(1),
  protocol: ProtocolSchema,
  account_id: z.string().min(1),
  api_key_id: z.string().min(1),
  user_id: z.string().nullable(),
  org_id: z.string().nullable(),
  requested_model: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
  tools: z.array(z.unknown()).nullable(),
  response_format: z.record(z.string(), z.unknown()).nullable(),
  attachments: z.array(z.unknown()).nullable(),
  max_tokens: z.number().int().positive().nullable(),
  stream: z.boolean(),
  metadata: RequestMetadataSchema,
});

// ── Inbound OpenAI Chat Completions request validation (boundary guard) ─────────
// The gateway must reject a malformed/invalid OpenAI request with 400
// invalid_request BEFORE normalization + routing (docs/07, principle 2: fail-
// closed). This validates only what makes a request well-formed enough to route:
// `messages` must be a non-empty array of role-bearing objects. Everything else
// (model, tools, response_format, temperature, …) is passed through loosely — we
// do NOT prematurely lock per-provider fields here. `model` is optional (absent →
// "auto"). Loose objects so unknown OpenAI fields never break parsing.
const OpenAIChatMessageSchema = z.looseObject({ role: z.string().min(1), content: z.unknown() });

export const OpenAIChatRequestSchema = z.looseObject({
  model: z.string().optional(),
  messages: z.array(OpenAIChatMessageSchema).min(1),
  stream: z.boolean().optional(),
});

export type OpenAIChatRequest = z.infer<typeof OpenAIChatRequestSchema>;

// Single source of truth: types via z.infer — no duplicate interfaces.
export type Protocol = z.infer<typeof ProtocolSchema>;
export type MemoryMode = z.infer<typeof MemoryModeSchema>;
export type RequestMetadata = z.infer<typeof RequestMetadataSchema>;
export type InternalRequest = z.infer<typeof InternalRequestSchema>;
