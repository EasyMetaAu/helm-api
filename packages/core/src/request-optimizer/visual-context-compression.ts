import type {
  Capabilities,
  NativePassthroughMutationLedger,
  TargetProviderProtocol,
  VisualContextCompressionMode,
} from "@helm/shared";
import {
  type KeepSharpBlock,
  type PxpipeTransformInput,
  type PxpipeTransformResult,
  transformAnthropicMessages,
} from "pxpipe-proxy/transform";

const ANTHROPIC_PIXELS_PER_TOKEN = 750;
const IMAGE_COST_SAFETY_MARGIN = 1.1;

type PxpipeTransformer = (input: PxpipeTransformInput) => Promise<PxpipeTransformResult>;

export type VisualContextCompressionMutation = NonNullable<
  NativePassthroughMutationLedger["visual_context_compression"]
>;

export interface VisualContextCompressionInput {
  mode: VisualContextCompressionMode;
  targetProviderProtocol: TargetProviderProtocol;
  model: string;
  body: Record<string, unknown>;
  capabilities?: Capabilities;
  requestId?: string;
  transformer?: PxpipeTransformer;
}

export interface VisualContextCompressionResult {
  body: Record<string, unknown>;
  mutation?: VisualContextCompressionMutation;
}

export type VisualContextCompressor = (
  input: VisualContextCompressionInput,
) => Promise<VisualContextCompressionResult>;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const HEX_RE = /\b[0-9a-f]{7,64}\b/i;
const LONG_NUMBER_RE = /\b\d{6,}\b/;
const URL_RE = /\bhttps?:\/\/\S+/i;
const PATH_RE = /(^|[\s"'`])(?:\/[\w./:@-]+|[A-Za-z]:\\[\w.\\:@-]+|[\w.-]+\/[\w./:@-]+)/;
const LINE_REF_RE = /(^|[\s"'`])[\w./-]+:\d{1,6}(:\d{1,6})?\b/;
const SECRETISH_RE =
  /\b(api[_-]?key|authorization|bearer|password|secret|token|credential|session[_-]?id|request[_-]?id|trace[_-]?id|account[_-]?id|user[_-]?id)\b/i;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

function defaultKeepSharp(block: KeepSharpBlock): boolean {
  const text = block.text;
  return (
    UUID_RE.test(text) ||
    HEX_RE.test(text) ||
    LONG_NUMBER_RE.test(text) ||
    URL_RE.test(text) ||
    PATH_RE.test(text) ||
    LINE_REF_RE.test(text) ||
    SECRETISH_RE.test(text) ||
    IP_RE.test(text)
  );
}

function estimateImageTokens(pixels: number | undefined): number | undefined {
  if (!Number.isFinite(pixels) || pixels === undefined || pixels <= 0) return undefined;
  return Math.ceil((pixels / ANTHROPIC_PIXELS_PER_TOKEN) * IMAGE_COST_SAFETY_MARGIN);
}

function safeDetail(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.length <= 200 ? value : `${value.slice(0, 197)}...`;
}

function mutationFromResult(
  mode: Exclude<VisualContextCompressionMode, "off">,
  result: PxpipeTransformResult,
  applied: boolean,
): VisualContextCompressionMutation {
  const imagePixels =
    typeof result.info.imagePixels === "number" && result.info.imagePixels >= 0
      ? Math.floor(result.info.imagePixels)
      : undefined;
  return {
    mode,
    applied,
    would_apply: result.applied,
    reason: result.reason,
    ...(safeDetail(result.detail) ? { detail: safeDetail(result.detail) } : {}),
    orig_chars: Math.max(0, Math.floor(result.info.origChars ?? 0)),
    compressed_chars: Math.max(0, Math.floor(result.info.compressedChars ?? 0)),
    image_count: Math.max(0, Math.floor(result.info.imageCount ?? 0)),
    image_bytes: Math.max(0, Math.floor(result.info.imageBytes ?? 0)),
    ...(imagePixels !== undefined ? { image_pixels: imagePixels } : {}),
    ...(estimateImageTokens(imagePixels) !== undefined
      ? { estimated_image_tokens: estimateImageTokens(imagePixels) }
      : {}),
    ...(typeof result.info.keptSharpBlocks === "number"
      ? { kept_sharp_blocks: Math.max(0, Math.floor(result.info.keptSharpBlocks)) }
      : {}),
    ...(typeof result.info.droppedChars === "number"
      ? { dropped_chars: Math.max(0, Math.floor(result.info.droppedChars)) }
      : {}),
    owns_cache_control: result.cache.ownsCacheControl,
    marker_count: Math.max(0, Math.floor(result.cache.markerCount)),
  };
}

function skippedMutation(
  mode: Exclude<VisualContextCompressionMode, "off">,
  reason: string,
  detail?: string,
): VisualContextCompressionMutation {
  return {
    mode,
    applied: false,
    would_apply: false,
    reason,
    ...(safeDetail(detail) ? { detail: safeDetail(detail) } : {}),
    orig_chars: 0,
    compressed_chars: 0,
    image_count: 0,
    image_bytes: 0,
    owns_cache_control: false,
    marker_count: 0,
  };
}

function parseObjectJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function optimizeVisualContext(
  input: VisualContextCompressionInput,
): Promise<VisualContextCompressionResult> {
  if (input.mode === "off") return { body: input.body };

  if (input.targetProviderProtocol !== "anthropic_messages") {
    return {
      body: input.body,
      mutation: skippedMutation(input.mode, "unsupported_protocol", input.targetProviderProtocol),
    };
  }
  if (input.capabilities && input.capabilities.supportsVision !== true) {
    return {
      body: input.body,
      mutation: skippedMutation(input.mode, "no_vision_support", input.model),
    };
  }

  const transformer = input.transformer ?? transformAnthropicMessages;
  const originalBytes = new TextEncoder().encode(JSON.stringify(input.body));
  let result: PxpipeTransformResult;
  try {
    result = await transformer({
      body: originalBytes,
      model: input.model,
      requestId: input.requestId,
      options: {
        compress: true,
        keepSharp: defaultKeepSharp,
        emitRecoverable: false,
      },
    });
  } catch (err) {
    return {
      body: input.body,
      mutation: skippedMutation(
        input.mode,
        "transform_error",
        err instanceof Error ? err.message : String(err),
      ),
    };
  }

  const applied = input.mode === "enabled" && result.applied;
  if (!applied) {
    return {
      body: input.body,
      mutation: mutationFromResult(input.mode, result, false),
    };
  }

  const transformedBody = parseObjectJson(result.body);
  if (transformedBody === null) {
    return {
      body: input.body,
      mutation: skippedMutation(input.mode, "transformed_body_parse_error", result.reason),
    };
  }

  return {
    body: transformedBody,
    mutation: mutationFromResult(input.mode, result, true),
  };
}
