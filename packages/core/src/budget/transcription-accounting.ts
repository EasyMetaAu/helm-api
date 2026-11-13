import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaPricing,
  MediaSpendRecord,
} from "@helm/shared";
import type { BudgetStore } from "../store/ports.js";
import { windowMsFor } from "./gate.js";
import { SpeechAccountingError } from "./speech-accounting.js";
import type { BudgetCaps, BudgetConfig } from "./types.js";
/** Only complete mono PCM16 WAV has a locally verified duration in this adapter. */
export function pcmWavDurationSeconds(bytes: Uint8Array): number | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 44 ||
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WAVE" ||
    b.readUInt32LE(4) !== b.length - 8
  )
    return null;
  let byteRate: number | undefined,
    dataBytes = 0,
    fmtCount = 0;
  for (let offset = 12; offset < b.length; ) {
    if (offset + 8 > b.length) return null;
    const type = b.toString("ascii", offset, offset + 4),
      size = b.readUInt32LE(offset + 4),
      start = offset + 8;
    if (start + size > b.length) return null;
    if (type === "fmt ") {
      if (
        ++fmtCount !== 1 ||
        size < 16 ||
        b.readUInt16LE(start) !== 1 ||
        b.readUInt16LE(start + 2) !== 1 ||
        b.readUInt16LE(start + 12) !== 2 ||
        b.readUInt16LE(start + 14) !== 16
      )
        return null;
      const sampleRate = b.readUInt32LE(start + 4);
      byteRate = b.readUInt32LE(start + 8);
      if (sampleRate < 8000 || sampleRate > 48000 || byteRate !== sampleRate * 2) return null;
    }
    if (type === "data") {
      if (size % 2) return null;
      dataBytes += size;
    }
    offset = start + size + (size % 2);
    if (offset > b.length) return null;
  }
  return byteRate && dataBytes > 0 ? dataBytes / byteRate : null;
}
export function quoteTranscription(card: MediaPricing | undefined, seconds: number): number | null {
  if (card?.rates.length !== 1 || card.conditionalFees?.length) return null;
  const rate = card.rates[0],
    rounding = card.billing?.roundingSeconds,
    fx = card.currency === "USD" ? 1 : card.billing?.usdPerCurrencyUnit;
  if (
    rate?.unit !== "second" ||
    rate.direction !== "input_audio" ||
    Object.keys(rate.conditions).length ||
    rate.freeQuantity ||
    !rounding ||
    !fx
  )
    return null;
  return Math.ceil(seconds / rounding) * rounding * rate.price * fx;
}
export interface TranscriptionAccounting {
  reserve(input: {
    id: string;
    keyId: string;
    alias: string;
    model: string;
    pricing?: MediaPricing;
    caps?: BudgetCaps;
    file: File;
    request: AudioTranscriptionRequest;
  }): Promise<MediaSpendRecord>;
  settle(
    record: MediaSpendRecord,
    pricing: MediaPricing | undefined,
    result: Pick<AudioTranscriptionResult, "usage"> | undefined,
    notSent?: boolean,
  ): Promise<MediaSpendRecord | null>;
}
export function createTranscriptionAccounting(
  store: BudgetStore,
  config: BudgetConfig,
): TranscriptionAccounting {
  return {
    async reserve(input) {
      if (!store.reserveMediaSpend) throw new SpeechAccountingError("media_accounting_unavailable");
      const cap = input.caps?.spendUsd ?? null;
      let quote: number | null = null;
      if (cap !== null) {
        const request = input.request;
        if (
          request.diarize ||
          request.keywords?.length ||
          (request.languages?.length ?? 0) > 1 ||
          request.languages?.includes("multi")
        )
          throw new SpeechAccountingError("media_pricing_unavailable");
        const duration = pcmWavDurationSeconds(new Uint8Array(await input.file.arrayBuffer()));
        if (duration !== null && input.pricing?.providerModel === input.model)
          quote = quoteTranscription(input.pricing, duration);
        if (quote === null) throw new SpeechAccountingError("media_pricing_unavailable");
      }
      const record: MediaSpendRecord = {
        id: input.id,
        keyId: input.keyId,
        alias: input.alias,
        providerModel: input.model,
        state: "reserved",
        reservedUsd: quote ?? 0,
        costUsd: null,
        capacity: cap,
        windowMs: input.caps ? windowMsFor(input.caps, config) : config.defaultWindowSeconds * 1000,
        admittedAtMs: input.caps?.admittedAtMs ?? Date.now(),
        anchorMs: input.caps?.weeklyAnchor ? Date.parse(input.caps.weeklyAnchor) : null,
        usage: null,
      };
      if (!(await store.reserveMediaSpend(record)))
        throw new SpeechAccountingError("budget_exceeded");
      return record;
    },
    async settle(record, pricing, result, notSent = false) {
      if (!store.settleMediaSpend) throw new SpeechAccountingError("media_accounting_unavailable");
      const usage = result?.usage;
      const cost =
        usage?.type === "duration" && pricing?.providerModel === record.providerModel
          ? quoteTranscription(pricing, usage.seconds * (usage.channels ?? 1))
          : null;
      return store.settleMediaSpend(
        record.id,
        record.keyId,
        { costUsd: notSent ? 0 : cost, usage: usage ?? null },
        Date.now(),
      );
    },
  };
}
