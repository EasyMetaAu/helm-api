import { MediaPricingSchema } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { SqliteBudgetStore } from "../store/sqlite/budget.js";
import { createSqliteDb } from "../store/sqlite/migrate.js";
import {
  createTranscriptionAccounting,
  pcmWavDurationSeconds,
  quoteTranscription,
} from "./transcription-accounting.js";

const wav = (samples = 16000) => {
  const b = Buffer.alloc(44 + samples * 2);
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
  b.writeUInt32LE(samples * 2, 40);
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

it("reserves a documented upper bound without converting it into settled cost", async () => {
  const price = {
    currency: "USD",
    providerModel: "nova-3",
    region: "global",
    basis: "official_list_price",
    verifiedOn: "2026-11-19",
    source: "https://deepgram.com/pricing",
    rates: [{ direction: "input_audio", unit: "second", price: 0.0043 / 60, conditions: {} }],
    notes: [],
  };
  const billing = { reservationRoundingSeconds: 1 };
  expect(
    MediaPricingSchema.safeParse({ ...price, billing: { ...billing, roundingSeconds: 1 } }).success,
  ).toBe(false);
  const card = MediaPricingSchema.parse({ ...price, billing });
  expect(quoteTranscription(card, 1.25)).toBeNull();

  const db = createSqliteDb(":memory:");
  try {
    const store = new SqliteBudgetStore(db);
    const accounting = createTranscriptionAccounting(store, {
      defaultWindowSeconds: 3600,
      defaultDegradeLane: "economy",
    });
    const now = Date.now();
    const caps = {
      requests: null,
      tokens: null,
      spendUsd: 0.0002,
      windowSeconds: null,
      behavior: "reject" as const,
      degradeLane: null,
      admittedAtMs: now,
    };
    const request = {
      id: "first",
      keyId: "key",
      alias: "deepgram/nova-3",
      model: "nova-3",
      pricing: card,
      file: new File([wav(20000)], "public.wav", { type: "audio/wav" }),
      request: { model: "nova-3" },
      caps,
    };
    const record = await accounting.reserve(request);
    expect(record.reservedUsd).toBeCloseTo((2 * 0.0043) / 60, 12);
    const usage = { type: "duration" as const, seconds: 1.25, channels: 1 };
    await accounting.settle(record, card, { usage });
    expect(await store.getMediaSpend?.(record.id, record.keyId)).toMatchObject({
      state: "outcome_unknown",
      costUsd: null,
      reservedUsd: record.reservedUsd,
      usage,
    });
    await expect(accounting.reserve({ ...request, id: "second" })).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    const refused = await accounting.reserve({ ...request, id: "refused", keyId: "not-sent" });
    await accounting.settle(refused, card, undefined, true);
    expect(await store.getMediaSpend?.(refused.id, refused.keyId)).toMatchObject({
      state: "settled",
      costUsd: 0,
    });
    await expect(
      accounting.reserve({ ...request, id: "after-refusal", keyId: refused.keyId }),
    ).resolves.toMatchObject({
      state: "reserved",
    });
  } finally {
    db.$sqlite.close();
  }
});
