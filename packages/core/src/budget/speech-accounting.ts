import type {
  MediaPricing,
  MediaSpeechRequest,
  MediaSpeechUsage,
  MediaSpendRecord,
} from "@helm/shared";
import type { BudgetStore } from "../store/ports.js";
import { windowMsFor } from "./gate.js";
import type { BudgetCaps, BudgetConfig } from "./types.js";

function characterPrice(card: MediaPricing | undefined): number | null {
  if (card?.rates.length !== 1) return null;
  const rate = card.rates[0];
  if (!rate || Object.keys(rate.conditions).length || rate.freeQuantity) return null;
  const unit =
    rate.unit === "million_billable_characters"
      ? 1000000
      : rate.unit === "ten_thousand_billable_characters"
        ? 10000
        : null;
  const fx = card.currency === "USD" ? 1 : card.billing?.usdPerCurrencyUnit;
  return unit && fx ? (rate.price / unit) * fx : null;
}
export function quoteSpeech(card: MediaPricing | undefined, text: string): number | null {
  const price = characterPrice(card),
    bound = card?.billing?.maxCharactersPerInputCodepoint;
  if (price === null || bound === undefined || !card) return null;
  const fx = card.currency === "USD" ? 1 : card.billing?.usdPerCurrencyUnit;
  if (!fx) return null;
  return (
    Array.from(text).length * bound * price +
    Math.max(0, ...(card.conditionalFees ?? []).map((fee) => fee.pricePerVoice * fx))
  );
}
export function priceSpeech(
  card: MediaPricing | undefined,
  usage: MediaSpeechUsage | undefined,
): number | null {
  const price = characterPrice(card);
  if (price === null || !card || usage?.usage_characters === undefined) return null;
  const voices = usage.usage_voice_count ?? 0;
  const fees = [...new Set((card.conditionalFees ?? []).map((fee) => fee.pricePerVoice))];
  if (voices && fees.length !== 1) return null;
  const fx = card.currency === "USD" ? 1 : card.billing?.usdPerCurrencyUnit;
  if (!fx) return null;
  return usage.usage_characters * price + voices * (fees[0] ?? 0) * fx;
}
export class SpeechAccountingError extends Error {
  constructor(
    readonly code: "media_pricing_unavailable" | "budget_exceeded" | "media_accounting_unavailable",
  ) {
    super(code);
  }
}
export interface SpeechAccounting {
  reserve(input: {
    id: string;
    keyId: string;
    alias: string;
    model: string;
    pricing?: MediaPricing;
    caps?: BudgetCaps;
    request: MediaSpeechRequest;
  }): Promise<MediaSpendRecord>;
  settle(
    record: MediaSpendRecord,
    pricing: MediaPricing | undefined,
    usage: MediaSpeechUsage | undefined,
    completed: boolean,
    notSent?: boolean,
  ): Promise<MediaSpendRecord | null>;
  get(id: string, keyId: string): Promise<MediaSpendRecord | null>;
}
export function createSpeechAccounting(store: BudgetStore, config: BudgetConfig): SpeechAccounting {
  return {
    async reserve(input) {
      if (!store.reserveMediaSpend) throw new SpeechAccountingError("media_accounting_unavailable");
      const cap = input.caps?.spendUsd ?? null;
      const quote =
        input.pricing?.providerModel === input.model
          ? quoteSpeech(input.pricing, input.request.input)
          : null;
      if (cap !== null && quote === null)
        throw new SpeechAccountingError("media_pricing_unavailable");
      const record: MediaSpendRecord = {
        id: input.id,
        keyId: input.keyId,
        alias: input.alias,
        providerModel: input.model,
        state: "reserved",
        reservedUsd: cap === null ? 0 : (quote ?? 0),
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
    async settle(record, pricing, usage, completed, notSent = false) {
      if (!store.settleMediaSpend) throw new SpeechAccountingError("media_accounting_unavailable");
      return store.settleMediaSpend(
        record.id,
        record.keyId,
        {
          costUsd: notSent
            ? 0
            : completed
              ? priceSpeech(
                  pricing?.providerModel === record.providerModel ? pricing : undefined,
                  usage,
                )
              : null,
          usage: usage ?? null,
        },
        Date.now(),
      );
    },
    async get(id, keyId) {
      if (!store.getMediaSpend) throw new SpeechAccountingError("media_accounting_unavailable");
      return store.getMediaSpend(id, keyId);
    },
  };
}
