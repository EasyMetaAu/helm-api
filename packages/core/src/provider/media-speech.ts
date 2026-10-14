import {
  type MediaSpeechRequest,
  type MediaSpeechUsage,
  MediaSpeechUsageSchema,
} from "@helm/shared";
import { z } from "zod";
import type { ProviderCallOptions } from "./openai.js";

const sequence = { sequence: z.number().int().nonnegative() };
export const SpeechEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...sequence,
    type: z.literal("started"),
    format: z.string(),
    sampleRate: z.number().positive(),
  }),
  z.object({
    ...sequence,
    type: z.literal("audio"),
    audio: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  }),
  z.object({ ...sequence, type: z.literal("usage"), usage: MediaSpeechUsageSchema }),
  z.object({
    ...sequence,
    type: z.enum(["request_final", "sentence_end", "flushed", "canceled", "completed"]),
  }),
  z.object({ ...sequence, type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type SpeechEvent = z.infer<typeof SpeechEventSchema>;
export type SpeechEventData = SpeechEvent extends infer E
  ? E extends { sequence: number }
    ? Omit<E, "sequence">
    : never
  : never;
export class SpeechParameterError extends Error {}
export interface SpeechSession {
  readonly events: AsyncIterable<SpeechEvent>;
  readonly capabilities: { flush: boolean; cancel: boolean };
  append(text: string): Promise<void>;
  flush(): Promise<void>;
  cancel(): Promise<void>;
  finish(): Promise<void>;
  close(): void;
}
export interface SpeechClient {
  ttsSpeech(
    req: Record<string, unknown>,
    opts?: ProviderCallOptions,
  ): Promise<{ audio: Uint8Array; contentType: string; usage?: MediaSpeechUsage }>;
  streamSpeech(
    req: Record<string, unknown>,
    opts?: ProviderCallOptions,
  ): AsyncIterable<SpeechEvent>;
  openSpeechSession?(
    req: Omit<MediaSpeechRequest, "input" | "stream">,
    opts?: ProviderCallOptions,
  ): Promise<SpeechSession>;
}
/** Transport owns connection/header/proxy handling; one fresh connection per session. */
export interface SpeechSocket {
  send(data: string): Promise<void>;
  readonly messages: AsyncIterable<string | Uint8Array>;
  close(): void;
}
export type SpeechSocketConnector = (input: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<SpeechSocket>;
export const speechMime = (format: string): string =>
  ({
    mp3: "audio/mpeg",
    wav: "audio/wav",
    pcm: "audio/pcm",
    flac: "audio/flac",
    opus: "audio/ogg",
  })[format] ?? "application/octet-stream";
export function decodeSpeechHex(value: string): Uint8Array {
  if (!value || value.length % 2 !== 0 || !/^[\da-f]+$/i.test(value))
    throw new Error("invalid speech audio hex");
  return new Uint8Array(Buffer.from(value, "hex"));
}
