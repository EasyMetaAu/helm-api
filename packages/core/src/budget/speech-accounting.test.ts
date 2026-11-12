import { describe, expect, it } from "vitest";
import { priceSpeech, quoteSpeech } from "./speech-accounting.js";

const card = {
  currency: "USD" as const,
  providerModel: "speech-2.8-hd",
  region: "global",
  basis: "official_list_price" as const,
  verifiedOn: "2026-11-12",
  source: "https://platform.minimax.io/docs/guides/pricing-paygo",
  notes: [],
  rates: [
    {
      direction: "output" as const,
      unit: "million_billable_characters" as const,
      price: 100,
      conditions: {},
    },
  ],
  conditionalFees: [
    { kind: "voice_design" as const, pricePerVoice: 3, charged: "first_synthesis_use" as const },
    {
      kind: "rapid_voice_cloning" as const,
      pricePerVoice: 1.5,
      charged: "first_synthesis_use" as const,
    },
  ],
};
describe("speech price and reservation", () => {
  it("does not invent an international billing upper bound", () => {
    expect(quoteSpeech(card, "hello")).toBeNull();
  });
  it("uses an explicit contract bound and reserves the possible first voice fee", () => {
    expect(
      quoteSpeech({ ...card, billing: { maxCharactersPerInputCodepoint: 2 } }, "hello"),
    ).toBeCloseTo(3.001);
  });
  it("prices native billable characters and leaves ambiguous voice fees unknown", () => {
    expect(priceSpeech(card, { usage_characters: 100 })).toBeCloseTo(0.01);
    expect(priceSpeech(card, { usage_characters: 100, usage_voice_count: 1 })).toBeNull();
  });
  it("does not pretend CNY is USD", () => {
    expect(priceSpeech({ ...card, currency: "CNY" }, { usage_characters: 100 })).toBeNull();
  });
});
