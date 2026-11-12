import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionAccounting,
  pcmWavDurationSeconds,
  quoteTranscription,
} from "./transcription-accounting.js";

const wav = () => {
  const b = Buffer.alloc(44 + 32000);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(32000, 40);
  return b;
};
describe("pre-dispatch audio duration", () => {
  it("reads complete mono PCM WAV and rejects duration from an incomplete header", () => {
    expect(pcmWavDurationSeconds(wav())).toBe(1);
    expect(pcmWavDurationSeconds(wav().subarray(0, 100))).toBeNull();
    expect(pcmWavDurationSeconds(Buffer.from("mp3"))).toBeNull();
  });
  it("requires an explicit duration billing rule", () => {
    const card = {
      currency: "USD" as const,
      providerModel: "nova-3",
      region: "global",
      basis: "official_list_price" as const,
      verifiedOn: "2026-11-12",
      source: "https://deepgram.com/pricing",
      notes: [],
      rates: [
        { direction: "input_audio" as const, unit: "second" as const, price: 0.01, conditions: {} },
      ],
    };
    expect(quoteTranscription(card, 1.2)).toBeNull();
    expect(quoteTranscription({ ...card, billing: { roundingSeconds: 1 } }, 1.2)).toBe(0.02);
  });
});

it("does not use a base rate for unpriced ASR feature options", async () => {
  const reserveMediaSpend = vi.fn().mockResolvedValue(true);
  const accounting = createTranscriptionAccounting(
    { reserveMediaSpend, peek: vi.fn(), debit: vi.fn() },
    { defaultWindowSeconds: 86400, defaultDegradeLane: "economy" },
  );
  const pricing = {
    currency: "USD" as const,
    providerModel: "nova-3",
    region: "global",
    basis: "official_list_price" as const,
    verifiedOn: "2026-11-12",
    source: "https://deepgram.com/pricing",
    notes: [],
    rates: [
      { direction: "input_audio" as const, unit: "second" as const, price: 0.01, conditions: {} },
    ],
    billing: { roundingSeconds: 1 },
  };
  await expect(
    accounting.reserve({
      id: "id",
      keyId: "k",
      alias: "deepgram/asr",
      model: "nova-3",
      pricing,
      file: new File([wav()], "a.wav"),
      request: { model: "nova-3", diarize: true },
      caps: {
        requests: null,
        tokens: null,
        spendUsd: 1,
        windowSeconds: null,
        behavior: "reject",
        degradeLane: null,
      },
    }),
  ).rejects.toMatchObject({ code: "media_pricing_unavailable" });
  expect(reserveMediaSpend).not.toHaveBeenCalled();
});
