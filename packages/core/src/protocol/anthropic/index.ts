import type { Transformer } from "../transformer.js";
import { transformRequestOut } from "./request.js";
import { transformResponseIn } from "./response.js";

// Anthropic Messages protocol barrel (docs/05). Re-exports the pure inbound/
// outbound/stream/error halves and assembles the 5-method `Transformer` the
// registry indexes. Framework-agnostic (CLAUDE.md principle 1): no Hono here —
// the gateway turns `endPoint` into a real route. Reimplemented from the docs,
// NOT copied from musistudio/llms or litellm.

export {
  type AnthropicErrorEnvelope,
  makeAnthropicError,
  transformErrorOut,
} from "./error.js";
export {
  type AnthropicMessagesRequest,
  transformRequestOut,
} from "./request.js";
export {
  type AnthropicMessagesResponse,
  AnthropicMessagesResponseSchema,
  type AnthropicStopReason,
  AnthropicStopReasonSchema,
  type AnthropicToolNameMap,
  type AnthropicUsage,
  AnthropicUsageSchema,
  createAnthropicToolNameMap,
  mapStopReason,
  mapUsage,
  transformResponseIn,
} from "./response.js";
export {
  type AnthropicSSEEvent,
  AnthropicSSEEventSchema,
  convertOpenAIStreamToAnthropic,
  type OpenAIChunk,
  OpenAIChunkSchema,
  synthesizeSSEFromJSON,
} from "./stream.js";

// The protocol transformer for the registry. The native-response direction reuses
// `transformResponseIn` (IR -> native Anthropic); the inbound provider direction
// (IR -> native request) is not needed for Anthropic-as-client and is omitted from
// the response path. Note: Anthropic is a client-presentation surface here, so the
// provider-direction transforms (transformRequestIn/transformResponseIn-from-
// provider) are covered by the dedicated stream/response modules and the executor.
export const anthropicTransformer: Pick<
  Transformer,
  "name" | "endPoint" | "transformRequestOut" | "transformResponseOut"
> = {
  name: "anthropic",
  endPoint: "/v1/messages",
  transformRequestOut(req) {
    return transformRequestOut(req);
  },
  transformResponseOut(ir) {
    return transformResponseIn(ir);
  },
};
