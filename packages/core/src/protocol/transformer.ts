import type { IRRequest, IRResponse } from "./ir.js";

// Protocol transformer contract (docs/05). Modeled on musistudio/llms: ONE class
// per protocol, FIVE members, with inbound and outbound translation living in the
// same file so a protocol is described in one place — the key to "rewritable,
// maintainable". All translation goes nativeIn -> IR -> nativeOut, so N protocols
// need 2N transforms, never N². Framework-agnostic per CLAUDE.md principle 1: this
// module imports no web framework and the mounting layer (gateway) consumes only
// abstract descriptions.

// Framework-agnostic abstract I/O. The native wire shape is `unknown` on purpose
// (no `any`, per CLAUDE.md code rules): each transformer narrows it with Zod
// internally. The host/gateway hands raw parsed JSON in and serializes out.
export type NativeRequest = unknown;
export type NativeResponse = unknown;

export interface Transformer {
  /** Protocol name; the registry's primary key, e.g. "openai" / "anthropic" / "gemini". */
  readonly name: string;

  /**
   * The inbound route this protocol owns (the mounting layer builds a route from
   * it). A pure outbound (provider-only) transformer may omit it.
   */
  readonly endPoint?: string;

  // —— Inbound direction (client → hub → client) ——
  /** Native inbound request → unified IR. */
  transformRequestOut(req: NativeRequest): IRRequest | Promise<IRRequest>;
  /** IR response → native response (sent back to the client in its requested protocol). */
  transformResponseOut(res: IRResponse): NativeResponse | Promise<NativeResponse>;

  // —— Outbound direction (hub → provider → hub) ——
  /** IR → native outbound request (sent to the upstream provider). */
  transformRequestIn(ir: IRRequest): NativeRequest | Promise<NativeRequest>;
  /** Provider native response → unified IR. */
  transformResponseIn(res: NativeResponse): IRResponse | Promise<IRResponse>;
}

// Stackable behavior transformer (cross-cutting concerns). Operates on IR only —
// NOT bound to any protocol — and is applied in sequence on top of the protocol
// transformer (e.g. max-token clamping, tool-use normalization, reasoning
// injection). Both hooks are optional and MUST be pure (return a new IR; do not
// mutate the input), so ordering is deterministic and composable.
export interface BehaviorTransformer {
  readonly name: string;
  applyRequest?(ir: IRRequest): IRRequest;
  applyResponse?(res: IRResponse): IRResponse;
}
