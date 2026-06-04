import type { IRChunk } from "../gemini/gemini-types.js";
import type { Transformer } from "../transformer.js";
import {
  type AnthropicOutboundRequest,
  transformRequestIn,
  transformRequestOut,
} from "./request.js";
import { transformNativeResponseToIR, transformResponseIn } from "./response.js";
import { type AnthropicSSEEvent, convertAnthropicStreamToIR } from "./stream.js";

// Anthropic Messages protocol barrel (docs/05). Re-exports the pure inbound/
// outbound/stream/error halves and assembles the full bidirectional `Transformer`
// the registry indexes. Framework-agnostic (CLAUDE.md principle 1): no Hono here —
// the gateway turns `endPoint` into a real route. Reimplemented from the docs,
// NOT copied from musistudio/llms or litellm.

export {
  type AnthropicErrorEnvelope,
  makeAnthropicError,
  transformErrorOut,
} from "./error.js";
export {
  type AnthropicOutputFormat,
  filterAnthropicOutputSchema,
  responseFormatToOutputFormat,
} from "./output-format.js";
export {
  type AnthropicMessagesRequest,
  type AnthropicOutboundRequest,
  type AnthropicOutboundTool,
  type AnthropicRequestBlock,
  type AnthropicRequestMessage,
  type AnthropicToolChoiceOut,
  transformRequestIn,
  transformRequestInWithWarnings,
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
  sanitizeAnthropicToolName,
  transformNativeResponseToIR,
  transformResponseIn,
} from "./response.js";
export {
  type AnthropicSSEEvent,
  AnthropicSSEEventSchema,
  convertAnthropicStreamToIR,
  convertOpenAIStreamToAnthropic,
  type OpenAIChunk,
  OpenAIChunkSchema,
  synthesizeSSEFromJSON,
} from "./stream.js";

// The full Anthropic protocol transformer (issue #59 makes it bidirectional):
//   • transformRequestOut: native Anthropic request -> IR (client-inbound)
//   • transformResponseOut: IR -> native Anthropic response (client-outbound)
//   • transformRequestIn:  IR -> native Anthropic request (provider-outbound)
//   • transformResponseIn: native Anthropic response -> IR (provider-inbound)
//   • transformStreamIn:   native Anthropic SSE events -> IR chunks (provider-inbound)
// transformResponseOut reuses the IR->native renderer (`transformResponseIn` in
// response.ts is the IR->Anthropic direction, kept under its historical name).
export const anthropicTransformer: Transformer & {
  transformStreamIn: (src: AsyncIterable<AnthropicSSEEvent>) => AsyncIterable<IRChunk>;
} = {
  name: "anthropic",
  endPoint: "/v1/messages",
  transformRequestOut(req) {
    return transformRequestOut(req);
  },
  transformResponseOut(ir) {
    return transformResponseIn(ir);
  },
  transformRequestIn(ir): AnthropicOutboundRequest {
    return transformRequestIn(ir);
  },
  transformResponseIn(res) {
    return transformNativeResponseToIR(res);
  },
  transformStreamIn(src) {
    return convertAnthropicStreamToIR(src);
  },
};
