import {
  BAILIAN_VIDEO_QUERY_WINDOW_MS,
  MINIMAX_VIDEO_QUERY_WINDOW_MS,
  normalizeBailianTranscription,
  normalizeBailianVideo,
  normalizeDoubaoTranscription,
  normalizeMiniMaxVideo,
  parseBailianCreated,
  parseMiniMaxVideoCreated,
  validateBailianTranscription,
  validateBailianVideo,
  validateDoubaoTranscription,
  validateMiniMaxVideo,
} from "@helm/core";
import type { ProviderConfig } from "@helm/shared";
import { mediaEndpointIdentity } from "./media-task-binding.js";
import type { NativeMediaTaskProfile } from "./native-media-tasks.js";

/** Query identity is derived again on every poll; configuration drift fails closed. */
export function nativeMediaProfile(
  p: ProviderConfig,
  kind: "video" | "transcription",
): NativeMediaTaskProfile | undefined {
  if (!["bailian-media", "minimax-media", "doubao-speech"].includes(p.type)) return undefined;
  if (p.type === "doubao-speech" && kind !== "transcription") return undefined;
  if (p.type === "minimax-media" && kind === "transcription") return undefined;
  const credential = p.api_key_env ? process.env[p.api_key_env] : undefined;
  if (!credential || !p.media_account_id || !p.base_url) return undefined;
  const endpointIdentity = mediaEndpointIdentity(p.base_url, p.media_account_id, credential);
  if (p.type === "doubao-speech")
    return {
      profile: "doubao",
      clientAssignedRequestId: true,
      endpointIdentity,
      // Local query retention policy, not a supplier retention guarantee.
      queryTtlMs: 24 * 60 * 60 * 1000,
      validate: validateDoubaoTranscription,
      parseCreated: (raw) => (typeof raw.id === "string" ? raw.id : null),
      normalize: normalizeDoubaoTranscription,
    };
  return p.type === "bailian-media"
    ? {
        profile: "bailian",
        endpointIdentity,
        queryTtlMs: BAILIAN_VIDEO_QUERY_WINDOW_MS,
        validate: kind === "video" ? validateBailianVideo : validateBailianTranscription,
        parseCreated: parseBailianCreated,
        normalize: kind === "video" ? normalizeBailianVideo : normalizeBailianTranscription,
      }
    : {
        profile: "minimax",
        endpointIdentity,
        queryTtlMs: MINIMAX_VIDEO_QUERY_WINDOW_MS,
        validate: validateMiniMaxVideo,
        parseCreated: parseMiniMaxVideoCreated,
        normalize: normalizeMiniMaxVideo,
      };
}
